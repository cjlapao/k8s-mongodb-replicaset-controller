import { ReplicaChanges } from './replica-changes';
import { PodMember } from './models/PodMember';

export class WorkerStatus {
  set?: string;
  lastStatusCode?: number;
  members: PodMember[];
  availablePods: PodMember[];
  changes: ReplicaChanges;
  hasChanges: boolean;

  constructor() {
    this.members = [];
    this.availablePods = [];
    this.changes = new ReplicaChanges();
    this.hasChanges = false;
  }

  init() {
    this.changes = new ReplicaChanges();
    this.hasChanges = false;
  }
}
