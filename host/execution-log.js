/**
 * Durable, append-only event log for one external execution run.
 *
 * The log is the source of truth for the node trace UI; it survives a plugin
 * reload even though the process that produced the events may not.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function rootDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'metainfer-research-lab', 'executions');
}

export function executionLogPath(projectId, nodeId, runId) {
  return path.join(rootDir(), projectId, nodeId, `${runId}.jsonl`);
}

export class ExecutionLog {
  constructor(filePath) {
    this.filePath = filePath;
    this.seq = 0;
    this.chain = Promise.resolve();
  }

  init() {
    return mkdir(path.dirname(this.filePath), { recursive: true });
  }

  append(event) {
    const record = {
      seq: ++this.seq,
      at: Date.now(),
      type: typeof event?.type === 'string' ? event.type : 'event',
      data: event ?? null,
    };
    this.chain = this.chain.then(() => appendFile(this.filePath, JSON.stringify(record) + '\n', 'utf8'));
    return this.chain.then(() => record);
  }

  drain() {
    return this.chain;
  }

  async read(after = 0) {
    await this.chain;
    let text = '';
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch {
      return { events: [], next: 0 };
    }
    const events = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (Number.isFinite(record.seq) && record.seq > after) events.push(record);
      } catch {
        // Ignore a partially written trailing line; the next read retries.
      }
    }
    return { events, next: events.length > 0 ? events[events.length - 1].seq : after };
  }
}
