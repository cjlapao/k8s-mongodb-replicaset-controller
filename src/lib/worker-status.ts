import { ReplicaSetStatus } from './models/replicaset-config';
import { ReplicaChanges } from './replica-changes';
import { PodMember } from './models/PodMember';

export class WorkerStatus {
  set?: string;
  lastStatusCode?: number;
  pods: PodMember[];
  replicaSetStatus?: ReplicaSetStatus;
  replicaSetStatusLastUpdate: number;
  primaryHost?: string;
  members: PodMember[];
  membersLastUpdated: number;
  availablePods: PodMember[];
  changes: ReplicaChanges;
  hasChanges: boolean;

  constructor() {
    this.pods = [];
    this.replicaSetStatusLastUpdate = -1;

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
