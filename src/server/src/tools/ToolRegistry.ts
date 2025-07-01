import { Tool } from "./Tool";
import { DOMParser } from "xmldom";
import { synthesizeSpeech } from "../tts";
import { NovaSonicBidirectionalStreamClient } from "../client";
import { WebSocket } from "ws";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// const fetchTecoFlowScriptData = async (
//   sessionId: string,
//   caseId: string,
//   processName: string,
//   processArguments: Map<string, string | number>
// ): Promise<Record<string, any>> => {
//   const lambdaClient = new LambdaClient({
//     region: process.env.AWS_REGION || "us-east-1",
//   });

//   try {
//     const payload = {
//       session_id: sessionId,
//       case_id: caseId,
//       next_process: {
//         name: processName,
//         arguments: processArguments,
//       },
//     };

//     console.log(
//       "fetchTecoFlowScriptData:----------------------------------",
//       payload
//     );

//     const command = new InvokeCommand({
//       FunctionName: "TecoFlowScript", // Replace with your Lambda function name
//       Payload: Buffer.from(JSON.stringify(payload)),
//     });

//     const response = await lambdaClient.send(command);

//     let result;
//     if (response.Payload) {
//       result = JSON.parse(Buffer.from(response.Payload).toString());
//     } else {
//       result = { error: "No payload returned from Lambda" };
//     }

//     return result;
//   } catch (error) {
//     console.error("Error invoking Lambda:", error);
//     throw error;
//   }
// };

const fetchTecoSonicProcessData = async (
  sessionId: string,
  caseId: string,
  processName: string,
  processArguments: Map<string, string | number>,
  // messagesList: string[]
): Promise<Record<string, any>> => {
  console.log(
    "%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%% fetchTecoSonicProcessData",
    // messagesList.length
  );
  const lambdaClient = new LambdaClient({
    region: process.env.AWS_REGION || "us-east-1",
  });

  try {
    const payload = {
      session_id: sessionId,
      case_id: caseId,
      run_process: { // changed from next_process to run_process
        name: processName,
        arguments: processArguments,
      },
    };

    console.log(
      "fetchTecoSonicProcessData payload:---------------------------------->",
      payload
    );

    const command = new InvokeCommand({
      // FunctionName: "TecoSonicProcess", // Replace with your Lambda function name
      FunctionName: "TecoSonicProcessScript", // Replace with your Lambda function name
      Payload: Buffer.from(JSON.stringify(payload)),
    });

    const response = await lambdaClient.send(command);

    let result;
    if (response.Payload) {
      result = JSON.parse(Buffer.from(response.Payload).toString());
    } else {
      result = { error: "No payload returned from Lambda" };
    }
    // messagesList.push(result);
    console.log("result:", result);
    console.log("%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%");
    return result;
  } catch (error) {
    console.error("Error invoking Lambda:", error);
    throw error;
  }
};

function startAudioContent(
  ws: WebSocket,
  promptName: string,
  contentName: string
): any {
  const event = {
    event: {
      contentStart: {
        promptName,
        contentName,
        type: "AUDIO",
        role: "USER",
        interactive: true,
        audioInputConfiguration: {
          mediaType: "audio/lpcm",
          sampleRateHertz: 16000,
          sampleSizeBits: 16,
          channelCount: 1,
          audioType: "SPEECH",
          encoding: "base64",
        },
      },
    },
  };
  ws.send(JSON.stringify(event));
  return event;
}

function endAudioContent(
  ws: WebSocket,
  promptName: string,
  contentName: string
): any {
  const event = {
    event: {
      contentEnd: {
        promptName,
        contentName,
        contentType: "SILENT_AUDIO",
      },
    },
  };
  ws.send(JSON.stringify(event));
  return event;
}

// async function funcion_lenta() {
//   await new Promise(
//     (resolve) => setTimeout(resolve, 10000) // result = llamaarLambda(),
//   );

//   return "funcion lenta ha terminado";
// }

async function triggerSonic(
  client: NovaSonicBidirectionalStreamClient,
  ws: WebSocket,
  toolUseContent: any,
  message: string
) {
  console.log("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA triggerSonic");
  const audioData = await synthesizeSpeech(message);
  const hardcodedSessionId = "a8c43fa3-cb29-4625-9fad-7a5589b19ca6";

  const { promptName } = toolUseContent;
  const contentName = client.contentNames.get(hardcodedSessionId);

  console.log("Starting silent audio stream WS");
  startAudioContent(ws, promptName, contentName);

  if (audioData) {
    const audioBytes =
      audioData instanceof Uint8Array ? audioData : new Uint8Array(audioData);
    const chunkSize = 1024;

    for (let i = 0; i < audioBytes.length; i += chunkSize) {
      const end = Math.min(i + chunkSize, audioBytes.length);
      const chunk = audioBytes.slice(i, end);
      const pcmData = new Int16Array(chunk.length / 2);
      for (let j = 0; j < chunk.length; j += 2) {
        pcmData[j / 2] = (chunk[j + 1] << 8) | chunk[j];
      }
      const base64Data = btoa(
        String.fromCharCode.apply(null, new Uint8Array(pcmData.buffer))
      );

      for (let i = 0; i < audioBytes.length; i += chunkSize) {
        const event = {
          event: {
            audioInput: {
              role: "USER",
              promptName,
              contentName,
              content: base64Data,
              contentType: "SILENT_AUDIO",
            },
          },
        };
        ws.send(JSON.stringify(event));
      }
    }
    console.log("######>>>>>>>1");
    setTimeout(() => {
      endAudioContent(ws, promptName, contentName);
      console.log("sent silent audio to WS");
    }, 1000);
    console.log("######>>>>>>>2");
  }
}

const functions = {
  follow_script: async (
    client: NovaSonicBidirectionalStreamClient,
    ws: WebSocket,
    toolUseContent: any,
    messagesList: string[]
  ) => {
    // console.log("########################################################");
    // console.log("toolUseContent:", toolUseContent.content);
    // console.log(
    //   "Type of toolUseContent.content:",
    //   typeof toolUseContent.content
    // );
    const contentObj =
      typeof toolUseContent.content === "string"
        ? JSON.parse(toolUseContent.content)
        : toolUseContent.content;
    console.log("Parsed:", contentObj);

    const sessionId = contentObj.session_id;
    const caseId = contentObj.case_id;
    const processName = contentObj.name;
    const processArguments = contentObj.arguments || {};

    // const { sessionId, caseId, processName, processArguments } = contentObj;

    console.log("-----------> follow_script called with:", {
      sessionId: sessionId,
      caseId: caseId,
      processName: processName,
      processArguments: processArguments,
    });
    try {
      const result = await fetchTecoSonicProcessData(
        sessionId,
        caseId,
        processName,
        processArguments
      );
      // console.log("-----------> Result from TecoFlowScript:", result);

      if (result.error) {
        return { content: `Error: ${result.error}` };
      }

      // messagesList.push(`The next step in your process is: ${result.next_process.name}`);
      // return { content: `The next step in your process is: ${result.next_process.name}` };
      // console.log("########################################################");
      return result;
    } catch (error) {
      console.error("Error in follow_script:", error);
      return { content: "An error occurred while processing your request." };
    }
  },

  // follow_script: async (
  //   client: NovaSonicBidirectionalStreamClient,
  //   ws: WebSocket,
  //   toolUseContent: any,
  //   messagesList: string[]
  // ) => {
  //   console.log("########################################################");
  //   const contentObj =
  //     typeof toolUseContent.content === "string"
  //       ? JSON.parse(toolUseContent.content)
  //       : toolUseContent.content;
  //   // console.log("Parsed:", contentObj);

  //   const sessionId = contentObj.session_id;
  //   const caseId = contentObj.case_id;
  //   const processName = contentObj.name;
  //   const processArguments = contentObj.arguments || {};

  //   console.log("-----------> follow_script called with:", {
  //     sessionId: sessionId,
  //     caseId: caseId,
  //     processName: processName,
  //     processArguments: processArguments,
  //   });


  //   // Call fetchTecoSonicProcessData asynchronously and triggerSonic when it completes
  //   fetchTecoSonicProcessData(
  //     sessionId,
  //     caseId,
  //     processName,
  //     processArguments,
  //   ).then((result) => {
  //     console.log("1111111111111111111111111111111111111111111111111");
  //     messagesList.push(JSON.stringify(result))
  //     console.log("2222222222222222222222222222222222222222222222222");

  //     new Promise((resolve) => setTimeout(resolve, 5000));

  //     triggerSonic(
  //       client,
  //       ws,
  //       toolUseContent,
  //       // "Chequea la respuesta al llamado que hiciste de la herramienta 'follow_script' "
  //       "check tool response"
  //     );
      
  //     console.log("-----------> returning from follow_script called with:");
  //     // return result;
      

  //   }).catch((error) => {
  //     console.error("Error in follow_script:", error);
  //   });

  //   const content = `El asistente debe informar al cliente que llamó al proceso '${processName}'.`
  //   console.log("content:", content);
  //   console.log("########################################################");
  //   return {
  //     content: content,
  //   };


  //   // try {
  //   //   const result = await fetchTecoSonicProcessData(
  //   //     sessionId,
  //   //     caseId,
  //   //     processName,
  //   //     processArguments,
  //   //     // messagesList
  //   //   );
  //   //   console.log(
  //   //     "-----------> Result from fetchTecoSonicProcessData:",
  //   //     result
  //   //   );

  //   //   if (result.error) {
  //   //     return { content: `Error: ${result.error}` };
  //   //   }

  //   //   console.log("########################################################");
  //   //   return result;
  //   // } catch (error) {
  //   //   console.error("Error in follow_script:", error);
  //   //   return { content: "An error occurred while processing your request." };
  //   // }
  // },

  // check_tool_response: async (
  //   client: NovaSonicBidirectionalStreamClient,
  //   ws: WebSocket,
  //   toolUseContent: any,
  //   messagesList: string[]
  // ) => {
  //   console.log("==================================================================",messagesList.length);
  //   console.log("All messages in messagesList:");
  //   messagesList.forEach((msg, idx) => {
  //     console.log(`[${idx}]:`, msg);
  //   });

  //   // console.log(messagesList)
  //   // if (messagesList.length > 0) {
  //   //   console.log(messagesList[0]);
  //   // } else {
  //   //   console.log("No messages in messagesList");
  //   // }
  //   await new Promise((resolve) => setTimeout(resolve, 3000));

  //   // let tool_response;
  //   // if(messagesList.length > 0) {
  //   //   tool_response = typeof messagesList[0] === "string" ? (() => {
  //   //     try {
  //   //       return JSON.parse(messagesList[0]);
  //   //     } catch {
  //   //       return { raw: messagesList[0] };
  //   //     }
  //   //     })() : messagesList[0]
  //   //   }
    

  //   console.log(
  //     "=================================================================="
  //   );

  //   return { content: messagesList.toString() };
  //   // return {
  //   //   content: "El asistente debe mencionar que tiene novedades o que ahora tiene más información, ya que debe transmitir la respuesta de la herramienta 'follow_script' al cliente.",
  //   // }
  // },

  // check_function_lenta: async (
  //   client: NovaSonicBidirectionalStreamClient,
  //   ws: WebSocket,
  //   toolUseContent: any,
  //   messagesList: string[]
  // ) => {
  //   console.log(
  //     "----------------> check_function_lenta called with toolUseContent:",
  //     toolUseContent.content,
  //     messagesList
  //   );

  //   await funcion_lenta().then(async (result) => {
  //     await triggerSonic(
  //       client,
  //       ws,
  //       toolUseContent,
  //       "La función lenta ha terminado. ¿Necesitas algo más?"
  //     );
  //   });

  //   return {
  //     content: `Estoy ejecutando una función lenta que tomará un tiempo considerable. Por favor, espera un momento.`,
  //   };
  // },

  // check_connection: async (
  //   client: NovaSonicBidirectionalStreamClient,
  //   ws: WebSocket,
  //   toolUseContent: any,
  //   messagesList: string[]
  // ) => {
  //   console.log(
  //     "----------------> check_connection called with toolUseContent:",
  //     toolUseContent.content,
  //     messagesList
  //   );
  //   // setTimeout(() => {
  //   //   const message = `He revisado el estado de tu conexión y detecté que en las últimas 24 horas
  //   //     hubo algunos problemas al registrar tu equipo en la red. Esto podría haber afectado la
  //   //     calidad de tu servicio. Para entender mejor lo que sucedió, voy a verificar si se registraron
  //   //     cortes específicos que hayan podido impactar tu conexión. Antes de continuar, ¿puedo confirmar
  //   //     que sigues ahí?`;
  //   //   messagesList.push(message);
  //   //   console.log(`Added message to messagesList: ${message}`);
  //   //   setTimeout(() => {
  //   //     triggerSonic(
  //   //       client,
  //   //       ws,
  //   //       toolUseContent,
  //   //       "Tienes mensajes para mi?"
  //   //     );
  //   //   }, 3000);
  //   // }, 5000);

  //   const message = `He revisado el estado de tu conexión y detecté que en las últimas 24 horas
  //       hubo algunos problemas al registrar tu equipo en la red. Antes de continuar, ¿puedo confirmar
  //       que sigues ahí?`;
  //   messagesList.push(message);
  //   console.log(`Added message to messagesList: ${message}`);

  //   setTimeout(() => {
  //     triggerSonic(
  //       client,
  //       ws,
  //       toolUseContent,
  //       "Tienes mensajes para mi?"
  //     );
  //   }, 3000);

  //   return {
  //     content: "Estoy revisando el estado de tu conexión en este momento.",
  //   };
  // },

  // check_for_outage: async (
  //   client: NovaSonicBidirectionalStreamClient,
  //   ws: WebSocket,
  //   toolUseContent: any,
  //   messagesList: string[]
  // ) => {
  //   console.log(
  //     "----------------> check_for_outage called with toolUseContent:",
  //     toolUseContent.content,
  //     messagesList
  //   );
  //   const { affectsAllUserDevices } = JSON.parse(toolUseContent.content);

  //   if (affectsAllUserDevices) {
  //     return {
  //       content:
  //         "Confirmé que hay una interrupción masiva en tu zona que está afectando tu servicio de internet. " +
  //         "Te avisaremos cuando el servicio se restablezca. ¿Querés que te avise por SMS cuando se restablezca el servicio?",
  //     };
  //   } else {
  //     functions.check_connection(client, ws, toolUseContent, messagesList);
  //     return {
  //       content:
  //         "He revisado y no encontré evidencia de una interrupción en tu zona. " +
  //         "Ahora estoy verificando si hay problemas específicos con tu conexión." +
  //         "Por favor, espera un momento.",
  //     };
  //   }
  // },

  get_weather: async (
    client: NovaSonicBidirectionalStreamClient,
    ws: WebSocket,
    toolUseContent: any,
    messagesList: string[]
  ) => {
    const { latitude, longitude } = JSON.parse(toolUseContent.content);

    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`;
      const response = await fetch(url, {
        headers: {
          "User-Agent": "MyApp/1.0",
          Accept: "application/json",
        },
      });
      const weatherData = await response.json();
      console.log("weatherData:", weatherData);

      return {
        weather_data: weatherData,
      };
    } catch (error) {
      console.error(`Error fetching weather data: ${error}`);
      throw error;
    }
  },
  get_current_time: async (
    client: NovaSonicBidirectionalStreamClient,
    ws: WebSocket,
    toolUseContent: any,
    messagesList: string[]
  ) => {
    try {
      const now = new Date();
      const current_time = now.toTimeString().slice(0, 5); // "HH:MM"
      console.log("current_time:", current_time);
      return {
        current_time: current_time,
      };
    } catch (error) {
      console.error(`Error fetching current time data: ${error}`);
      throw error;
    }
  },
};

function parseToolsFromXML(
  xmlString: string,
  functions: Record<string, Function> = {}
): Array<typeof Tool> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "text/xml");
  const tools = doc.getElementsByTagName("tool");

  const toolClasses: Array<typeof Tool> = [];

  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    const id = tool.getAttribute("id")!;
    const functionName = tool.getAttribute("function")!;
    const description = tool.getAttribute("description")!;
    const properties = tool.getElementsByTagName("property");

    const schema = {
      type: "object",
      properties: {} as any,
      required: [] as string[],
    };

    for (let j = 0; j < properties.length; j++) {
      const prop = properties[j];
      const name = prop.getAttribute("name")!;
      const type = prop.getAttribute("type")!;
      const required = prop.getAttribute("required") === "true";
      const desc = prop.getAttribute("description")!;

      schema.properties[name] = {
        type: type,
        description: desc,
      };

      if (required) {
        schema.required.push(name);
      }
    }

    const toolClass = class extends Tool {
      public static id = id;
      public static schema = schema;
      public static toolSpec = {
        toolSpec: {
          name: id,
          description: description,
          inputSchema: {
            json: JSON.stringify(schema),
          },
        },
      };

      public static async execute(
        client: NovaSonicBidirectionalStreamClient,
        ws: WebSocket,
        toolUseContent: any,
        messagesList: string[]
      ) {
        const func = functions[functionName];
        if (func) {
          return await func(client, ws, toolUseContent, messagesList);
        }
        return {};
      }
    };

    Object.defineProperty(toolClass, "name", { value: id });
    toolClasses.push(toolClass);
  }

  return toolClasses;
}

export const registeredTools = parseToolsFromXML(
  // `
  // <tool id="get_current_time" function="get_current_time" description="La hora actual en formato HH:MM."></tool>
  // <tool id="get_weather" function="get_weather" description="Get the current weather for a given location, based on its WGS84 coordinates.">
  //   <property name="latitude" type="string" required="true" description="Geographical WGS84 latitude of the location." />
  //   <property name="longitude" type="string" required="true" description="Geographical WGS84 longitude of the location." />
  // </tool>
  // <tool id="follow_script" function="follow_script" description="Esta herramienta sirve para correr procesos para diagnosticar y resolver problemas de conexión a internet.">
  //   <property name="session_id" type="string" required="true" description="The session ID for the process." />
  //   <property name="case_id" type="string" required="true" description="The case ID for the process." />
  //   <property name="name" type="string" required="true" description="The name of the next process to follow." />
  //   <property name="arguments" type="object" required="true" description="Arguments for the next process." />
  // </tool>
  // <tool id="check_tool_response" function="check_tool_response" description="Esta herramienta sirve para obtener el resultado del ultimo proceso llamado para diagnosticar y resolver problemas de conexión a internet."/>
  // `,
  `
  <tool id="get_current_time" function="get_current_time" description="La hora actual en formato HH:MM."></tool>
  <tool id="get_weather" function="get_weather" description="Get the current weather for a given location, based on its WGS84 coordinates.">
    <property name="latitude" type="string" required="true" description="Geographical WGS84 latitude of the location." />
    <property name="longitude" type="string" required="true" description="Geographical WGS84 longitude of the location." />
  </tool>
  <tool id="follow_script" function="follow_script" description="Esta herramienta sirve para correr procesos para diagnosticar y resolver problemas de conexión a internet.">
    <property name="session_id" type="string" required="true" description="El session ID para la conversación." />
    <property name="case_id" type="string" required="true" description="El case id del proceso de resolución." />
    <property name="name" type="string" required="true" description="El name del proceso a correr para diagnosticar o resolver el problema de conexión." />
    <property name="arguments" type="object" required="true" description="los arguments necesarios para el proceso a correr para diagnosticar o resolver el problema de conexión." />
  </tool>
  `,
  // `
  // <tool id="check_messages" function="check_messages" description="Usa esta herramienta para chequear si el cliente tiene mensajes no leídos."/>
  // <tool id="check_connection" function="check_connection" description="Usa esta herramienta para verificar si hay un problema de conexión en el área del usuario."/>
  // <tool id="check_for_outage" function="check_for_outage" description="Usa esta herramienta para verificar si hay un corte en el área del usuario. No asumas cuántos dispositivos están afectados sin preguntar.">
  //   <property name="affectsAllUserDevices" type="boolean" required="true" description="Si la interrupción afecta a todos los dispositivos del usuario" />
  // </tool>
  // <tool id="get_current_time" function="get_current_time" description="La hora actual en formato HH:MM."></tool>
  // <tool id="get_weather" function="get_weather" description="Get the current weather for a given location, based on its WGS84 coordinates.">
  //   <property name="latitude" type="string" required="true" description="Geographical WGS84 latitude of the location." />
  //   <property name="longitude" type="string" required="true" description="Geographical WGS84 longitude of the location." />
  // </tool>
  // <tool id="follow_script" function="follow_script" description="Esta herramienta sirve para obtener el siguiente paso de un proceso para diagnosticar y resolver problemas de conexión a internet.">
  //   <property name="session_id" type="string" required="true" description="The session ID for the process." />
  //   <property name="case_id" type="string" required="true" description="The case ID for the process." />
  //   <property name="name" type="string" required="true" description="The name of the next process to follow." />
  //   <property name="arguments" type="object" required="true" description="Arguments for the next process." />
  // </tool>
  // `,

  //   `
  // <tool id="get_current_time" function="get_current_time" description="La hora actual en formato HH:MM."></tool>
  // <tool id="get_weather" function="get_weather" description="Get the current weather for a given location, based on its WGS84 coordinates.">
  //   <property name="latitude" type="string" required="true" description="Geographical WGS84 latitude of the location." />
  //   <property name="longitude" type="string" required="true" description="Geographical WGS84 longitude of the location." />
  // </tool>
  // <tool id="follow_script" function="follow_script" description="Obtener el siguiente paso de un proceso estructurado para diagnosticar y resolver problemas de conexión a internet de manera eficiente.">
  //   <property name="session_id" type="string" required="true" description="The session ID for the process." />
  //   <property name="case_id" type="string" required="true" description="The case ID for the process." />
  //   <property name="name" type="string" required="true" description="The name of the next process to follow." />
  //   <property name="arguments" type="object" required="true" description="Arguments for the next process." />
  // </tool>
  // `
  // ,
  functions
);

export class ToolRegistry {
  private tools: Map<
    string,
    (
      client: NovaSonicBidirectionalStreamClient,
      ws: WebSocket,
      content: any,
      messagesList: string[]
    ) => Promise<any>
  > = new Map();
  public messagesList: string[] = [];

  constructor() {
    this.registerXMLTools();
    // Add startup scripts here.
  }

  getToolSpecs() {
    return registeredTools.map((ToolClass) => ToolClass.toolSpec);
  }

  private registerXMLTools(): void {
    registeredTools.forEach((ToolClass) => {
      this.tools.set(ToolClass.id, ToolClass.execute.bind(ToolClass));
    });
  }

  async execute(
    client: NovaSonicBidirectionalStreamClient,
    ws: WebSocket,
    toolName: string,
    content: any
  ): Promise<any> {
    const handler = this.tools.get(toolName);
    if (!handler) {
      throw new Error(`Tool ${toolName} not supported`);
    }
    return handler(client, ws, content, this.messagesList);
  }
}

export default registeredTools;
