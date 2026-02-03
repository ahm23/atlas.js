// src/messages/composer.ts
import { EncodeObject } from '@cosmjs/proto-signing';
import { nebulix } from '@atlas/atlas.js-protos';
import { MsgPostFile } from '@atlas/atlas.js-protos/dist/types/nebulix/storage/v1/tx';
import { MsgDeleteNode, MsgPostNode } from '@atlas/atlas.js-protos/dist/types/nebulix/filetree/v1/tx';

export class MessageComposer {
  /**
   * Creates a properly formatted EncodeObject for file upload
   */
  static MsgPostFile(
    fid: string,
    creator: string,
    merkleRoot: Uint8Array,
    fileSize: number,
    replicas: number = 3,
    subscription: string = "sub_0"
  ): EncodeObject {
    // Use the MessageComposer from your protos
    return {
      typeUrl: MsgPostFile.typeUrl,
      value: MsgPostFile.fromPartial({
        fid,
        creator,
        merkle: merkleRoot,
        fileSize: BigInt(fileSize),
        replicas: replicas,
        subscription
      })
    };
  }

  /**
   * Creates a file tree node message
   */
  static MsgPostNode(
    creator: string,
    path: string,
    nodeType: 'file' | 'directory' | 'drive',
    contents: string
  ): EncodeObject {
    return {
      typeUrl: MsgPostNode.typeUrl,
      value: MsgPostNode.fromPartial({
        creator,
        path,
        nodeType,
        contents
      })
    };
  }

  static MsgDeleteNode(
    path: string,
    creator: string,
  ): EncodeObject {
    // Use the MessageComposer from your protos
    return {
      typeUrl: MsgDeleteNode.typeUrl,
      value: MsgDeleteNode.fromPartial({
        path,
        creator
      })
    };
  }


  /**
   * Creates a cosmos bank send message
   */
  static createBankSendMsg(
    fromAddress: string,
    toAddress: string,
    amount: string, // e.g., "1000uatl"
    denom: string = "uatl"
  ): EncodeObject {
    const cosmos = require('cosmjs-types/cosmos/bank/v1beta1/tx');
    
    return {
      typeUrl: "/cosmos.bank.v1beta1.MsgSend",
      value: cosmos.MsgSend.fromPartial({
        fromAddress,
        toAddress,
        amount: [{ denom, amount }]
      })
    };
  }
}