import { NovaSonicBidirectionalStreamClient } from "../client";
import { WebSocket } from "ws";

export abstract class Tool {
  public static id: string;
  public static schema: {
    type?: string;
    properties: any;
    required: string[];
  }
  public static toolSpec: {
    toolSpec: {
      name: string;
      description: string;
      inputSchema: {
        json: any;
      };
    };
  };

  public static async execute(client: NovaSonicBidirectionalStreamClient, ws: WebSocket, toolUseContent: object, messagesList: string[]): Promise<any> {
    return {};
  }
}
