import { PodMember } from './models/PodMember';

export class ReplicaChanges {
  isPrimarySteppingDown: boolean;
  masterSteppingDown?: PodMember;
  masterSteppingUp?: PodMember;
  changes: ReplicaSetChange[];

  get hasChanges(): boolean {
    return this.changes.length > 0 ? true : false;
  }

  constructor() {
    this.isPrimarySteppingDown = false;
    this.changes = [];
  }
}

export interface ReplicaSetChange {
  _id: number;
  host: string;
  priority: number;
  votes: number;
  isMaster: boolean;
  isSteppingDown: boolean;
  action: 'ADD' | 'REMOVE';
}
