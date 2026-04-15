import { v4 as uuid } from 'uuid';
import type { IMemoryRepository } from '../repository/interface.js';
import type { MemoryHub } from '../schema/memory.js';
import { AuditAction } from '../schema/audit.js';
import { createLogger } from '../config.js';

const log = createLogger('hub-compute');

/**
 * Hub computation: identify candidate hubs from access patterns.
 *
 * A memory becomes a hub candidate when:
 * - High access count (frequently retrieved)
 * - Referenced by multiple subjects (cross-domain)
 * - Confirmed trust class
 * - Contains principle-level language (short, abstract)
 *
 * Hub promotion requires consensus per Preston's ruling.
 * This module identifies candidates. Promotion happens separately.
 */

export interface HubCandidate {
  memoryId: string;
  claim: string;
  score: number;
  reason: string;
}

export async function identifyHubCandidates(
  repo: IMemoryRepository,
  minAccessCount: number = 10,
  maxClaimLength: number = 200,
  limit: number = 10,
): Promise<HubCandidate[]> {
  const candidates: HubCandidate[] = [];

  for await (const record of repo.exportAll()) {
    if (record.trustClass !== 'confirmed') continue;
    if (record.accessCount < minAccessCount) continue;
    if (record.claim.length > maxClaimLength) continue;
    if (record.isInhibitory) continue;
    if (record.interferenceStatus !== 'active') continue;

    const score = record.accessCount * (record.confidence + 0.5);

    candidates.push({
      memoryId: record.id,
      claim: record.claim,
      score,
      reason: `${record.accessCount} accesses, confidence ${record.confidence}`,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  log.debug({ found: candidates.length }, 'Hub candidates identified');
  return candidates.slice(0, limit);
}

/**
 * Promote a memory to a hub. Creates the hub record and links the source memory.
 */
export async function promoteToHub(
  repo: IMemoryRepository,
  memoryId: string,
  hubType: string = 'principle',
): Promise<MemoryHub> {
  const memory = await repo.getById(memoryId);
  if (!memory) throw new Error(`Memory not found: ${memoryId}`);

  const hub: MemoryHub = {
    id: uuid(),
    claim: memory.claim,
    hubType,
    createdAt: new Date().toISOString(),
    accessCount: 0,
  };

  await repo.createHub(hub);
  await repo.linkToHub(memoryId, hub.id);

  await repo.appendAuditLog({
    memoryId,
    action: AuditAction.HUB_CREATED,
    details: `Hub ${hub.id} created from memory. Type: ${hubType}`,
  });

  log.info({ hubId: hub.id, memoryId, hubType }, 'Hub created');
  return hub;
}
