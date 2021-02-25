import { ReplicaSetStateMember } from './replicaset-config';
import { V1Pod } from '@kubernetes/client-node';

export interface PodMember {
  id?: number;
  k8sPod?: V1Pod;
  mongoNode?: ReplicaSetStateMember;
  host?: string;
  ip?: string;
  isRunning?: boolean;
  isPrimary?: boolean;
  priority?: number;
  votes?: number;
  change?: 'ADD' | 'REMOVE' | 'UNCHANGED';
}
