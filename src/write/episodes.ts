/**
 * Episode Writer: groups facts into narrative episodes.
 * 
 * Algorithm:
 * 1. Load fact_facets for a set of facts
 * 2. Group by primary_subject
 * 3. Within subject: cluster by topic_key + temporal proximity
 * 4. Semantic coherence: avg pairwise cosine > 0.45
 * 5. Clusters of 3+ facts → episode
 * 6. LLM call (Haiku): generate title + summary
 * 7. Embed summary, insert episode + episode_facts + episode_vec
 * 
 * Flag: EPISODES_ENABLED=true
 */

import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import type { MemoryRecord } from '../schema/memory.js';
import type { FactFacet } from './facets.js';
import { encode, isInitialized } from '../embeddings/index.js';
import { createLogger } from '../config.js';

const log = createLogger('episodes');

const MIN_CLUSTER_SIZE = 3;
const COSINE_COHERENCE_THRESHOLD = 0.45;
const TEMPORAL_PROXIMITY_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface Episode {
  id: string;
  subject: string;
  title: string;
  summary: string;
  timeframe_start: string | null;
  timeframe_end: string | null;
  session_source: string | null;
  fact_count: number;
  created_at: string;
  updated_at: string;
}

export interface EpisodeFact {
  episode_id: string;
  fact_id: string;
  ordinal: number;
}

// --- Clustering ---

interface FactWithFacet {
  record: MemoryRecord;
  facet: FactFacet;
}

/**
 * Cluster facts by topic + temporal proximity within a subject.
 */
function clusterFacts(facts: FactWithFacet[]): FactWithFacet[][] {
  if (facts.length < MIN_CLUSTER_SIZE) return [];

  // Group by topic_key first
  const byTopic = new Map<string, FactWithFacet[]>();
  for (const f of facts) {
    const key = f.facet.topic_key || '__none__';
    if (!byTopic.has(key)) byTopic.set(key, []);
    byTopic.get(key)!.push(f);
  }

  const clusters: FactWithFacet[][] = [];

  for (const [_topic, topicFacts] of byTopic) {
    if (topicFacts.length < MIN_CLUSTER_SIZE) {
      // Too few for a topic cluster. Try temporal grouping.
      continue;
    }

    // Sort by creation time
    topicFacts.sort((a, b) => {
      const tA = a.facet.event_time || a.record.createdAt;
      const tB = b.facet.event_time || b.record.createdAt;
      return new Date(tA).getTime() - new Date(tB).getTime();
    });

    // Temporal proximity clustering within topic
    let current: FactWithFacet[] = [topicFacts[0]!];
    for (let i = 1; i < topicFacts.length; i++) {
      const prev = topicFacts[i - 1]!;
      const curr = topicFacts[i]!;
      const prevTime = new Date(prev.facet.event_time || prev.record.createdAt).getTime();
      const currTime = new Date(curr.facet.event_time || curr.record.createdAt).getTime();

      if (currTime - prevTime <= TEMPORAL_PROXIMITY_MS || isNaN(prevTime) || isNaN(currTime)) {
        // Same session/day, extend cluster
        current.push(curr);
      } else {
        if (current.length >= MIN_CLUSTER_SIZE) clusters.push(current);
        current = [curr];
      }
    }
    if (current.length >= MIN_CLUSTER_SIZE) clusters.push(current);
  }

  // Also try all no-topic facts as a single cluster
  const noTopic = byTopic.get('__none__');
  if (noTopic && noTopic.length >= MIN_CLUSTER_SIZE) {
    clusters.push(noTopic);
  }

  return clusters;
}

/**
 * Check semantic coherence of a cluster using pairwise cosine similarity.
 * Returns true if avg pairwise cosine > threshold.
 */
function checkCoherence(embeddings: (number[] | null)[]): boolean {
  const valid = embeddings.filter((e): e is number[] => e !== null && e.length > 0);
  if (valid.length < 2) return true; // Can't check, assume coherent

  let totalSim = 0;
  let pairs = 0;

  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      totalSim += cosineSimilarity(valid[i]!, valid[j]!);
      pairs++;
    }
  }

  if (pairs === 0) return true;
  return totalSim / pairs >= COSINE_COHERENCE_THRESHOLD;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// --- LLM title/summary generation ---

/**
 * Generate episode title and summary via Haiku.
 * Falls back to deterministic generation if API is unavailable.
 */
async function generateTitleAndSummary(
  subject: string,
  claims: string[],
  apiKey: string | undefined,
): Promise<{ title: string; summary: string }> {
  if (!apiKey) {
    return deterministicTitleSummary(subject, claims);
  }

  try {
    const prompt = `Given these facts about "${subject}":\n${claims.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nGenerate:\n1. A short title (max 8 words) capturing the core topic/event\n2. A brief summary (max 200 characters) connecting these facts\n\nRespond ONLY in this exact format:\nTITLE: <title>\nSUMMARY: <summary>`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      log.warn({ status: res.status }, 'Haiku API call failed, using deterministic fallback');
      return deterministicTitleSummary(subject, claims);
    }

    const data = await res.json() as { content: Array<{ text: string }> };
    const text = data.content[0]?.text || '';
    
    const titleMatch = text.match(/TITLE:\s*(.+)/);
    const summaryMatch = text.match(/SUMMARY:\s*(.+)/);

    return {
      title: titleMatch?.[1]?.trim().slice(0, 100) || deterministicTitle(subject, claims),
      summary: summaryMatch?.[1]?.trim().slice(0, 200) || deterministicSummary(subject, claims),
    };
  } catch (err) {
    log.warn({ err }, 'Episode title/summary generation failed, using deterministic fallback');
    return deterministicTitleSummary(subject, claims);
  }
}

function deterministicTitle(subject: string, claims: string[]): string {
  const firstClaim = claims[0] || '';
  const words = firstClaim.split(/\s+/).slice(0, 6).join(' ');
  return `${subject}: ${words}`.slice(0, 100);
}

function deterministicSummary(subject: string, claims: string[]): string {
  return `${subject} - ${claims.length} related facts: ${claims.slice(0, 2).join('; ')}`.slice(0, 200);
}

function deterministicTitleSummary(subject: string, claims: string[]): { title: string; summary: string } {
  return {
    title: deterministicTitle(subject, claims),
    summary: deterministicSummary(subject, claims),
  };
}

// --- Database operations ---

function insertEpisode(db: Database.Database, episode: Episode): void {
  db.prepare(`
    INSERT OR REPLACE INTO episodes (id, subject, title, summary, timeframe_start, timeframe_end, session_source, fact_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    episode.id, episode.subject, episode.title, episode.summary,
    episode.timeframe_start, episode.timeframe_end, episode.session_source,
    episode.fact_count, episode.created_at, episode.updated_at,
  );
}

function insertEpisodeFact(db: Database.Database, ef: EpisodeFact): void {
  db.prepare(`
    INSERT OR IGNORE INTO episode_facts (episode_id, fact_id, ordinal) VALUES (?, ?, ?)
  `).run(ef.episode_id, ef.fact_id, ef.ordinal);
}

function insertEpisodeVec(db: Database.Database, id: string, embedding: number[]): void {
  db.prepare(`
    INSERT OR REPLACE INTO episode_vec (id, embedding) VALUES (?, ?)
  `).run(id, new Float32Array(embedding));
}

// --- Main builder ---

/**
 * Build episodes from a set of fact IDs.
 * Called after benchmark seeding or after a batch of writes.
 */
export async function buildEpisodes(
  db: Database.Database,
  factIds: string[],
  apiKey: string | undefined,
): Promise<Episode[]> {
  if (process.env.EPISODES_ENABLED !== 'true') return [];
  if (factIds.length < MIN_CLUSTER_SIZE) return [];

  // Load facts and facets
  const facts: FactWithFacet[] = [];
  for (const fid of factIds) {
    const row = db.prepare('SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL').get(fid) as Record<string, unknown> | undefined;
    if (!row) continue;
    const facet = db.prepare('SELECT * FROM fact_facets WHERE fact_id = ?').get(fid) as Record<string, unknown> | undefined;
    if (!facet) continue;

    // Minimal record reconstruction for embedding lookup
    const embedding = db.prepare('SELECT embedding FROM memories_vec WHERE id = ?').get(fid) as { embedding: Float32Array } | undefined;

    facts.push({
      record: {
        id: row.id as string,
        claim: row.claim as string,
        subject: row.subject as string,
        createdAt: row.created_at as string,
        validFrom: (row.valid_from as string) || null,
        embedding: embedding ? Array.from(embedding.embedding) : null,
      } as MemoryRecord,
      facet: {
        fact_id: facet.fact_id as string,
        primary_subject: facet.primary_subject as string,
        mentioned_subjects: facet.mentioned_subjects as string,
        fact_kind: facet.fact_kind as string,
        topic_key: (facet.topic_key as string) || null,
        slot_group: (facet.slot_group as string) || null,
        slot_key: (facet.slot_key as string) || null,
        event_time: (facet.event_time as string) || null,
        turn_span_start: null,
        turn_span_end: null,
      },
    });
  }

  // Group by subject
  const bySubject = new Map<string, FactWithFacet[]>();
  for (const f of facts) {
    const subj = f.facet.primary_subject;
    if (!bySubject.has(subj)) bySubject.set(subj, []);
    bySubject.get(subj)!.push(f);
  }

  const episodes: Episode[] = [];
  const now = new Date().toISOString();

  for (const [subject, subjectFacts] of bySubject) {
    const clusters = clusterFacts(subjectFacts);

    for (const cluster of clusters) {
      // Coherence check
      const embeddings = cluster.map(f => f.record.embedding);
      if (!checkCoherence(embeddings)) {
        log.debug({ subject, clusterSize: cluster.length }, 'Cluster failed coherence check, skipping');
        continue;
      }

      const claims = cluster.map(f => f.record.claim);
      const { title, summary } = await generateTitleAndSummary(subject, claims, apiKey);

      // Compute timeframe
      const times = cluster
        .map(f => f.facet.event_time || f.record.createdAt)
        .filter(t => t && !isNaN(new Date(t).getTime()))
        .sort();

      const episodeId = uuid();
      const episode: Episode = {
        id: episodeId,
        subject,
        title,
        summary,
        timeframe_start: times[0] || null,
        timeframe_end: times[times.length - 1] || null,
        session_source: null,
        fact_count: cluster.length,
        created_at: now,
        updated_at: now,
      };

      // Insert episode
      insertEpisode(db, episode);

      // Insert episode_facts
      for (let i = 0; i < cluster.length; i++) {
        insertEpisodeFact(db, {
          episode_id: episodeId,
          fact_id: cluster[i]!.record.id,
          ordinal: i,
        });
      }

      // Embed and insert into episode_vec
      if (isInitialized()) {
        try {
          const summaryEmbedding = await encode(summary);
          insertEpisodeVec(db, episodeId, summaryEmbedding);
        } catch (err) {
          log.warn({ episodeId, err }, 'Failed to embed episode summary');
        }
      }

      episodes.push(episode);
      log.debug({ episodeId, subject, title, factCount: cluster.length }, 'Episode created');
    }
  }

  log.info({ episodeCount: episodes.length, inputFacts: factIds.length }, 'Episode building complete');
  return episodes;
}

/**
 * Build episodes for all facts in the database (benchmark backfill).
 */
export async function buildAllEpisodes(db: Database.Database, apiKey: string | undefined): Promise<Episode[]> {
  const rows = db.prepare('SELECT id FROM memories WHERE deleted_at IS NULL').all() as { id: string }[];
  const factIds = rows.map(r => r.id);
  return buildEpisodes(db, factIds, apiKey);
}
