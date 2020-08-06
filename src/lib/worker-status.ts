import { ReplicaChanges } from './replica-changes';
import { PodMember } from './models/PodMember';

export class WorkerStatus {
  set?: string;
  lastStatusCode?: number;
  members: PodMember[];
  membersLastUpdated: number;
  availablePods: PodMember[];
  changes: ReplicaChanges;
  hasChanges: boolean;

  constructor() {
    this.members = [];
    this.membersLastUpdated = -1;
    this.availablePods = [];
    this.changes = new ReplicaChanges();
    this.hasChanges = false;
  }

  init() {
    this.changes = new ReplicaChanges();
    this.hasChanges = false;
  }
}
