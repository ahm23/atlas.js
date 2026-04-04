import { StorageSubscription } from "@atlas/atlas.js-protos/dist/types/nebulix/storage/v1/subscription";

export interface IQueryHelper {


  subscription(address: string, id: string): Promise<StorageSubscription>;
  subscriptions(address: string): Promise<StorageSubscription[]>;

}