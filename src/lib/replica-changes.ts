import { PodMember } from './models/PodMember';

export class ReplicaChanges {
  podsToAdd: PodMember[];
  podsToRemove: PodMember[];

  constructor() {
    this.podsToAdd = [];
    this.podsToRemove = [];
  }
}
