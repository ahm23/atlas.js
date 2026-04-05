import { QuerySubscriptionRequest } from "@atlas/atlas.js-protos/dist/types/nebulix/storage/v1/query";
import { IQueryHelper } from "./interfaces/classes/IQueryHelper";
import { QueryClient } from "./wallets";
import { StorageSubscription } from "@atlas/atlas.js-protos/dist/types/nebulix/storage/v1/subscription";
import { File } from "@atlas/atlas.js-protos/dist/types/nebulix/storage/v1/file";
import { FileNode } from "@atlas/atlas.js-protos/dist/types/nebulix/filetree/v1/tree";


export class QueryHelper implements IQueryHelper {

  protected client: QueryClient
  constructor(client: QueryClient) {
    this.client = client
  }

  async subscription(address: string, id: string = "sub_0"): Promise<StorageSubscription> {
    const res = await this.client.nebulix.storage.v1.subscription({ 
      subscriberAddress: address,
      subscriptionId: id
    })

    return res.subscription
  }

  async subscriptions(address: string): Promise<StorageSubscription[]> {
    const res = await this.client.nebulix.storage.v1.subscriptions({ 
      subscriberAddress: address
    })

    return res.subscriptions
  }

  async file(fid: string): Promise<File> {
    const res = await this.client.nebulix.storage.v1.file({ 
      fid
    })

    return res.file
  }

  async fileNode(path: string, owner: string): Promise<FileNode> {
    const res = await this.client.nebulix.filetree.v1.fileNode({ 
      path, 
      owner 
    })

    return res.node
  }
}