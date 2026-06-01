import * as fs from 'fs';
import * as path from 'path';
import { EventStore } from './EventStore.js';
import { Component, DomainEventName, FeatureStatus } from '../constants/index.js';
import { Logger } from './Logger.js';

export interface Feature {
  id: string;
  title: string;
  status: FeatureStatus;
  notes?: string;
}

export class FeatureListManager {
  private filePath: string;

  constructor(
    worktreePath: string,
    private readonly eventStore: EventStore
  ) {
    this.filePath = path.join(worktreePath, 'feature_list.json');
  }

  public load(): Feature[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      Logger.warn(Component.CORE, 'Failed to parse feature list file', { filePath: this.filePath, error: String(error) });
      return [];
    }
  }

  public save(features: Feature[]) {
    fs.writeFileSync(this.filePath, JSON.stringify(features, null, 2));
    void this.eventStore.record(DomainEventName.FEATURE_LIST_UPDATED, {
      path: this.filePath,
      featureCount: features.length
    }).catch(() => {});
  }

  public updateFeature(id: string, update: Partial<Feature>) {
    const features = this.load();
    const index = features.findIndex(f => f.id === id);
    if (index !== -1) {
      features[index] = { ...features[index], ...update };
      this.save(features);
    }
  }
}
