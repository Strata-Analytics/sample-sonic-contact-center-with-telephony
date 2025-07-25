import "dotenv/config";
import * as https from "https";
import { WebSocket } from "ws";
import bodyParser from "body-parser";
import express, { Request, Response } from "express";
import expressWs from "express-ws";
import { BrowserIntegration } from "./telephony/browser";
import { Buffer } from "node:buffer";
import { NovaSonicBidirectionalStreamClient } from "./client";
import { Session, SessionEventData } from "./types";
import { TwilioIntegration } from "./telephony/twilio";
import { VonageIntegration } from "./telephony/vonage";
import { fromEnv } from "@aws-sdk/credential-providers";
import { v4 as uuidv4 } from "uuid";
// import { triggerSonic } from "./tools/ToolRegistry";
// import { GenesysIntegration } from "./telephony/genesys";

const app = express();
const wsInstance = expressWs(app);
app.use(bodyParser.json());
app.get("/socket/test", (req: Request, res: Response) => {
  res.send("Este es un texto cualquiera de prueba en /socket/test");
});
const bedrockClient = new NovaSonicBidirectionalStreamClient({
  requestHandlerConfig: {
    maxConcurrentStreams: 10,
  },
  clientConfig: {
    region: process.env.AWS_REGION || "us-east-1",
    credentials: fromEnv(),
  },
});

// Integrations

function isTrue(s: string | undefined) {
  return s?.toLowerCase() === "true";
}

const browser = new BrowserIntegration(
  isTrue(process.env.BROWSER_ENABLED),
  app
);
const vonage = new VonageIntegration(isTrue(process.env.VONAGE_ENABLED), app);
const twilio = new TwilioIntegration(isTrue(process.env.TWILIO_ENABLED), app);
// const genesys = new GenesysIntegration(isTrue(process.env.GENESYS_ENABLED), app);

/* Periodically check for and close inactive sessions (every minute).
 * Sessions with no activity for over 5 minutes will be force closed
 */
setInterval(() => {
  console.log("Running session cleanup check");
  const now = Date.now();

  bedrockClient.getActiveSessions().forEach((sessionId: string) => {
    const lastActivity = bedrockClient.getLastActivityTime(sessionId);

    const fiveMinsInMs = 10 * 60 * 1000;
    if (now - lastActivity > fiveMinsInMs) {
      console.log(`Closing inactive session ${sessionId} due to inactivity.`);
      try {
        bedrockClient.closeSession(sessionId);
      } catch (error: unknown) {
        console.error(
          `Error force closing inactive session ${sessionId}:`,
          error
        );
      }
    }
  });
}, 60000);

// Track active websocket connections with their session IDs
const channelStreams = new Map<string, Session>(); // channelId -> Session
const channelClients = new Map<string, Set<WebSocket>>(); // channelId -> Set of connected clients
const clientChannels = new Map<WebSocket, string>(); // WebSocket -> channelId

wsInstance.getWss().on("connection", (ws: WebSocket) => {
  console.log("Websocket connection is open");
});

function setUpEventHandlersForChannel(session: Session, channelId: string) {
  function handleSessionEvent(
    session: Session,
    channelId: string,
    eventName: string,
    isError: boolean = false
  ) {
    session.onEvent(eventName, (data: SessionEventData) => {
      console[isError ? "error" : "debug"](eventName, data);

      // Broadcast to all clients in this channel
      const clients = channelClients.get(channelId) || new Set();
      const message = JSON.stringify({ event: { [eventName]: { ...data } } });

      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    });
  }

  handleSessionEvent(session, channelId, "contentStart");
  handleSessionEvent(session, channelId, "textOutput");
  handleSessionEvent(session, channelId, "error", true);
  handleSessionEvent(session, channelId, "toolUse");
  handleSessionEvent(session, channelId, "toolResult");
  handleSessionEvent(session, channelId, "contentEnd");

  session.onEvent("streamComplete", () => {
    console.log("Stream completed for channel:", channelId);

    const clients = channelClients.get(channelId) || new Set();
    const message = JSON.stringify({ event: "streamComplete" });
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    });
  });

  session.onEvent("audioOutput", (data: SessionEventData) => {
    const CHUNK_SIZE_BYTES = 640;
    const SAMPLES_PER_CHUNK = CHUNK_SIZE_BYTES / 2;

    const clients = channelClients.get(channelId) || new Set();

    const buffer = Buffer.from(data["content"], "base64");
    const pcmSamples = new Int16Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.length / Int16Array.BYTES_PER_ELEMENT
    );

    let offset = 0;
    // Default way to send audio samples to the websocket clients.
    while (offset + SAMPLES_PER_CHUNK <= pcmSamples.length) {
      const chunk = pcmSamples.slice(offset, offset + SAMPLES_PER_CHUNK);
      clients?.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(chunk);
      });
      offset += SAMPLES_PER_CHUNK;
    }
    // if (genesys.isOn) genesys.tryProcessAudioOutput(pcmSamples, clients, session.streamId!);
    // Twilio takes a different format for audio samples.
    if (twilio.isOn)
      twilio.tryProcessAudioOutput(pcmSamples, clients, session.streamId!);
    if (browser.isOn) browser.tryProcessAudioOutput(data, clients);
  });
}

wsInstance.app.ws("/socket", (ws: WebSocket, req: Request) => {
  // Get channel from query parameters or use a default
  const channelId = req.query.channel?.toString() || uuidv4();
  console.log(`Client requesting connection to channel: ${channelId}`);

  const sendError = (message: string, details: string) => {
    ws.send(JSON.stringify({ event: "error", data: { message, details } }));
  };

  async function tryProcessNovaSonicMessage(msg: any, session: Session) {
    try {
      const jsonMsg = JSON.parse(msg.toString());

      // Create handler functions.
      const handlePromptStart = async (jsonMsg, session) =>
        await session.setupPromptStart();
      const handleSystemPrompt = async (jsonMsg, session) =>
        await session.setupSystemPrompt(undefined, jsonMsg.data);
      const handleAudioStart = async (jsonMsg, session) =>
        await session.setupStartAudio();
      const handleStopAudio = async (jsonMsg, session) => {
        await session.endAudioContent();
        await session.endPrompt();
      };

      // Create map of [ messageTag -> handlerFunction ]
      let novaSonicHandlers = new Map<
        string,
        (jsonMsg: any, session: Session) => Promise<void>
      >([
        ["promptStart", handlePromptStart],
        ["systemPrompt", handleSystemPrompt],
        ["audioStart", handleAudioStart],
        ["stopAudio", handleStopAudio],
      ]);

      // Try use JSON messages with `.event` prop.
      let handler = novaSonicHandlers.get(jsonMsg.type);
      if (handler) await handler(jsonMsg, session);
    } catch (e) {}
  }

  const initializeOrJoinChannel = async () => {
    try {
      let session: Session;
      let isNewChannel = false;

      if (channelStreams.has(channelId)) {
        console.log(`Client joining existing channel: ${channelId}`);
        session = channelStreams.get(channelId)!;
      } else {
        console.log(`Creating new channel: ${channelId}`);
        session = bedrockClient.createStreamSession(channelId);
        bedrockClient.initiateSession(channelId, ws);
        channelStreams.set(channelId, session);
        channelClients.set(channelId, new Set());

        setUpEventHandlersForChannel(session, channelId);
        await session.setupPromptStart();

        await session.setupSystemPrompt(
          undefined,
      //     // Con check_tool_response
      //     "Eres un asistente de soporte en una compañía telefónica. Tú y el cliente participarán en un diálogo hablado manteniendo una conversación natural en tiempo real. El asistente debe dar respuestas cortas, generalmente de una o dos frases. Tu tarea es ayudar al cliente con problemas en su conexión a internet de manera eficiente, profesional y empática.\n" +
      // "- Si el cliente no ha mencionado el motivo de su llamada, pregúntale: cuál es el problema con su conexión a internet?\n" +
      // "- Si el cliente ya mencionó su problema con internet, utiliza la herramienta 'follow_script' para ejecutar procesos que te guiarán paso a paso con el diagnostico y resolución del problema que tiene el cliente.\n" +
      // "- La primera vez que uses la herramienta 'follow_script' invocala con 'next_process'.'name': 'VerificarOutageBloqueante' y 'next_process'.'arguments': '{}'.\n\n" +
      
      // "- Cada vez que uses la herramienta 'follow_script', por pedido del cliente, debes chequear el resultado con la herramienta 'check_tool_response' para saber como sigue el proceso de diagnostico y resolucion de problemas con internet.\n" +
      // "- En la respuesta de 'check_tool_response' revisa la propiedad 'prompt' para tener contexto para hablar con el cliente y saber como sigue el proceso de diagnóstico y resolución del problema.\n" +

      // "- Para determinar el siguiente paso, consulta la lista 'next_process' en la ultima respuesta de 'check_tool_response':\n" +
      // "-- Si la lista 'next_process' tiene un solo elemento, debes llamar a 'follow_script' usa el 'name' y 'arguments' de ese unico elemento.\n" +
      // "-- Si la lista 'next_process' tiene dos elementos, pregunta al cliente según las indicaciones de 'prompt' y elige el elemento más adecuado para el proximo llamado a 'follow_script'.\n\n" +
      
      // "- Si la herramienta 'follow_script' devuelve un error, utiliza la propiedad 'fix' para corregir el llamado.\n" +
      // "-- El proceso de llamar a la herramienta 'follow_script' y checquear sus resultados en 'check_tool_response' finaliza cuando 'check_tool_response' devuelve una lista vacía en 'next_process'\n" +
      // "-- Nunca inventes valores para 'name' o 'arguments' al llamar a la herramienta 'follow_script'; usa el que seleccionaste de la lista 'next_process' de la ultima respuesta de la herramienta 'check_tool_response'.\n" +
      // "-- Los valores posibles de 'name' al usar la herramienta son 'follow_script' son: 'VerificarOutageBloqueante', 'InternetHFCVerificarHistorico', 'InternetHFCVerificarCortes', 'DiagnosticoCM', 'Uptime', 'CheckCM', 'InternetVelocidadContratada', 'EndFlow'.\n\n" +
      
      // "- No siempre es necesario llamar la tool 'follow_script' para responder las preguntas del cliente.\n" +
      // // - Si al buscar los resultados "CheckToolResponse" para "InternetHFCVerificarCortes" se identifican inconvenientes de señal en las últimas 24 horas, no sigas inmediatamente con 'DiagnosticoCM'. En su lugar, verifica conversando con el cliente los cortes de servicio son reales.
      // // - Al verificar caidas reales con el cliente pregunta al cliente sin llamar la herramienta 'follow_script' para decidir si las caídas fueron provocadas intencionalmente o no. Cuando sepas cómo llamar a la herramienta 'follow_script' hazlo con unos de los items en 'next_process' en la respuesta de la llamada anterior.

      // // - Si el usuario pregunta la hora, puedes usar la herramienta 'get_current_time'.

      // // - Responde las preguntas que esten relacionada al proceso de diagnostico o solución del problema que el cliente este teniendo.
      // // - Si el cliente decide no continuar con el proceso, respeta su decisión, no uses la herramienta y despídete amablemente.
      // // "- Cuando el usuario enpiece su mensaje con 'Silent message:' tienes que seguir la instrucción\n" +

      // "- Importante, no llames herramientas mas de una vez seguida sin antes hablar con el cliente en cada respuesta; siempre mantén la interacción y al cliente informado.\n" +
      // "- Responde de manera natural a cualquier interrupción del cliente y nunca ignores sus comentarios.\n" +
      // "- Evita repetir frases; mantén la conversación natural y variada.\n\n" +

      // "- Sigue estas indicaciones cuando encuentres en el texto del 'prompt' lo siguiente:\n" +
      // "-- Si encuentras 'CM' di Cable Modem\n" +
      // "-- Si encuentras 'HFC' di Fibra Híbrida Coaxial.\n" +
      // "-- Si encuentras 'Mbps' di megabits por segundo.\n" +
      // "-- Para las horas no menciones los segundos. Por ejemplo, si el tiempo es 12:30:45, simplemente di 'doce y treinta' horas." +

      // // "- No hay diferencia en el proceso de diagnóstico y resolución con los pasos a seguir si el cliente tiene una conexión por CM (cable modem) o HFC (Fibra híbrida coaxial).\n\n" +
      // "- Recuerda: tu objetivo es guiar al cliente paso a paso, asegurando que comprenda el proceso y se sienta acompañado en todo momento.\n\n"


      // // Solo follow_script

      // // {
      // //   statusCode: 200,
      // //   result: 'INDISPONIBILIDAD',
      // //   current_process: { name: 'VerificarOutageBloqueante', arguments: {} },
      // //   response: {
      // //     description: 'Lista de servicios afectados por cortes masivos',
      // //     data: [ [Object] ]
      // //   },
      // //   prompt: "El assistente debe informar al cliente que en este momento el servicio se encuentra afectado por una falla masiva. El asistente puede usar los datos en 'response' para dar mas informacion sobre la falla masiva, también puede usar 'outageStartTime' para informar cuando comenzó la falla, y con el atributo 'timeResolution' puede indicar el tiempo estidado de resolución del problema. ",
      // //   next_process: [ { name: 'EndFlow', arguments: {} } ]
      // // }

      //   "Eres un asistente de soporte en una compañía telefónica. Tú y el cliente participarán en un diálogo hablado manteniendo una conversación natural en tiempo real. El asistente debe dar respuestas cortas, generalmente de una o dos frases. Tu tarea es ayudar al cliente con problemas en su conexión a internet de manera eficiente, profesional y empática.\n" +
      // "- Si el cliente no ha mencionado el motivo de su llamada, pregúntar cuál es el problema con su conexión a internet?\n" +
      // "- Si el cliente ya mencionó su problema con internet, utilizar la herramienta 'follow_script' para ejecutar procesos que te guiarán paso a paso con el diagnostico y resolución del problema que tiene el cliente.\n" +
      // "- La primera vez que uses la herramienta 'follow_script' invocarla con 'next_process'.'name': 'VerificarOutageBloqueante' y 'next_process'.'arguments': '{}'.\n" +
      // "- No iventar formas de solucionar el problema de conexion del cliente, hay que ajustarse a las respuestas de la herramiente 'follow_script'. No investar formas de solucionar el problema sin llamar a la herramienta 'follow_script'.\n\n" +
      
      // "- Cada vez que uses la herramienta 'follow_script', revisa la propiedad 'prompt' en la respuesta para tener contexto para hablar con el cliente respecto al proceso que se esta ejecutando y como sigue el proceso de diagnóstico y resolución del problema de conexión.\n" +
      // "- Interpreta y parafrasea el 'prompt' de la respuesta de la herramienta ya que es una guía para tu conversación con el cliente. No leas literalmente el 'prompt' ya que son directivas sobre qué decirle al cliente.\n\n" +
      // // - Interpreta y parafrasea el 'prompt' de la respuesta de la herramienta ya que es una guía para tu conversación con el cliente. No leas literalmente el 'prompt' ya que son directivas sobre qué decirle al cliente. No menciones al cliente como objecto directo o indirecto en una frase, por ejemplo en:
      // //     - "Pregúntale al cliente como es el problema que tiene...", en su lugar, di algo como "Como es el problema que tienes...";
      // //     - "Consulta al cliente si las distintas caídas fueron provocadas intencionalmente...", en su lugar, di algo como "Vamos a verificar si las caídas fueron provocadas intencionalmente...".
      // //     - "Si el cliente no recuerda haber hecho...", en lugar, di algo como "No recuerdas haber hecho...".
      // //     - "El proceso X ha comenzado.", en su lugar, di algo explica lo que vas a hacer sin decir "El proceso X ha comenzado".

      // // "## Uso de 'follow_script ##" +
      // "- Para determinar el siguiente paso, consulta la lista 'next_process' en la respuesta de 'follow_script':\n" +
      // "-- Si en la lista 'next_process' hay un solo elemento, cuando llames nuevamente a 'follow_script' usa los valores para 'name' y 'arguments' de ese elemento.\n" +
      // "-- Si en la lista 'next_process' hay dos elementos, pregunta al cliente según las indicaciones de 'prompt' y elige el elemento más adecuado para el proximo llamado a 'follow_script'.\n" +
      // // - Siempre incluye las claves 'case_id', 'session_id' y 'next_process' para llamar a la herramienta 'follow_script'.
      // "-- Si la herramienta 'follow_script' devuelve un error, utiliza la propiedad 'fix' para corregir el llamado.\n" +
      // "-- El proceso de llamar a la herramienta 'follow_script' finaliza cuando devuelve una lista vacía en 'next_process', usala hasta que esto suceda.\n" +
      // "-- Nunca inventes valores para 'name' o 'arguments' para llamar a la herramienta 'follow_script'; usa el que seleccionaste de la lista 'next_process' de la respuesta anterior.\n" +
      // "-- Los valores posibles de 'name' al usar la herramienta son 'follow_script' son: 'VerificarOutageBloqueante', 'InternetHFCVerificarHistorico', 'InternetHFCVerificarCortes', 'DiagnosticoCM', 'Uptime', 'CheckCM', 'InternetVelocidadContratada', 'EndFlow'.\n\n" +

      // "- No siempre es necesario llamar la tool 'follow_script' para responder las preguntas del cliente.\n" +
      // // - Si al buscar los resultados "CheckToolResponse" para "InternetHFCVerificarCortes" se identifican inconvenientes de señal en las últimas 24 horas, no sigas inmediatamente con 'DiagnosticoCM'. En su lugar, verifica conversando con el cliente los cortes de servicio son reales.
      // // - Al verificar caidas reales con el cliente pregunta al cliente sin llamar la herramienta 'follow_script' para decidir si las caídas fueron provocadas intencionalmente o no. Cuando sepas cómo llamar a la herramienta 'follow_script' hazlo con unos de los items en 'next_process' en la respuesta de la llamada anterior.

      // // - Si el usuario pregunta la hora, puedes usar la herramienta 'get_current_time'.

      // // - Responde las preguntas que esten relacionada al proceso de diagnostico o solución del problema que el cliente este teniendo.
      // // - Si el cliente decide no continuar con el proceso, respeta su decisión, no uses la herramienta y despídete amablemente.
      // // "- Cuando el usuario enpiece su mensaje con 'Silent message:' tienes que seguir la instrucción\n" +

      // // "- No llames herramientas mas de una vez seguida sin antes hablar con el cliente en cada respuesta; siempre mantén la interacción y al cliente informado.\n" +
      // "- Responde de manera natural a cualquier interrupción del cliente y nunca ignores sus comentarios.\n" +
      // "- Evita repetir frases; mantén la conversación natural y variada.\n\n" +
      

      // "- Sigue estas indicaciones cuando encuentres en el texto del 'prompt' lo siguiente:\n" +
      // "-- Si encuentras 'CM' di Cable Modem\n" +
      // // "-- Si encuentras 'HFC' di Fibra Híbrida Coaxial.\n" +
      // "-- Si encuentras 'Mbps' di megabits por segundo.\n" +
      // "-- Para las horas no menciones los segundos. Por ejemplo, si el tiempo es 12:30:45, simplemente di 'doce y treinta' horas." +
      // // "- Sigue estas indicaciones cuando encuentres en el texto del 'prompt' lo siguiente:\n" +
      // // "-- 'CM' es Cable Modem\n" +
      // // "-- 'HFC' es Fibra Híbrida Coaxial.\n" +
      // // "-- 'Mbps' es megabits por segundo.\n" +
      // // "-- Para las horas no menciones los segundos. Por ejemplo, si el tiempo es 12:30:45, simplemente di 'doce y treinta' horas." +

      // // "- No hay diferencia en el proceso de diagnóstico y resolución con los pasos a seguir si el cliente tiene una conexión por CM (cable modem) o HFC (Fibra híbrida coaxial).\n\n" +
      // "- Recuerda: tu objetivo es guiar al cliente paso a paso, asegurando que comprenda el proceso y se sienta acompañado en todo momento.\n\n"

          // `Eres un asistente de soporte en una compañía telefónica. Tú y el cliente participarán en un diálogo hablado intercambiando las transcripciones de una conversación natural en tiempo real. Mantén tus respuestas cortas, generalmente de una o dos frases para escenarios conversacionales. Tu tarea es ayudar al cliente con problemas en su conexión a internet de manera eficiente, profesional y empática.`

      // #### Solo follow_script run_process (TecoSonicProcessScript)

      // {
      //   statusCode: 200,
      //   result: 'INDISPONIBILIDAD',
      //   current_process: { name: 'VerificarOutageBloqueante', arguments: {} },
      //   response: {
      //     description: 'Lista de servicios afectados por cortes masivos',
      //     data: [ [Object] ]
      //   },
      //   prompt: "El assistente debe informar al cliente que en este momento el servicio se encuentra afectado por una falla masiva. El asistente puede usar los datos en 'response' para dar mas informacion sobre la falla masiva, también puede usar 'outageStartTime' para informar cuando comenzó la falla, y con el atributo 'timeResolution' puede indicar el tiempo estidado de resolución del problema. ",
      //   next_process: [ { name: 'EndFlow', arguments: {} } ]
      // }

        "Eres un asistente de soporte en una compañía telefónica. Tú y el cliente participarán en un diálogo hablado manteniendo una conversación natural en tiempo real. El asistente debe dar respuestas cortas, generalmente 1 o 2 frases. Tu tarea es ayudar al cliente con problemas en su conexión a internet de manera eficiente, profesional y empática.\n" +
      "- Si el cliente no ha mencionado el motivo de su llamada, pregúntar cuál es el problema con su conexión a internet.\n" +
      "- Si el cliente ya mencionó su problema con internet, debes chequear que si hay un corte masivo que este afectando al cliente usando la herramienta 'follow_script' que te ayudara a diagnosticar y resolver el problema, las respuestas de 'follow_script' te guiarán paso a paso en la conversación con el cliente.\n\n" +
      // "- No inventar formas de solucionar el problema del cliente sin llamar a la herramienta 'follow_script', te tienes que ajustar a las respuestas de la herramiente 'follow_script'.\n\n" +

      "## Dinamica de uso de la herramienta 'follow_script':\n" +
      "- La primera vez que uses la herramienta 'follow_script' debes invocarla con 'run_process'.'name': 'VerificarOutageBloqueante' y 'run_process'.'arguments': '{}', de este modo comienza el proceso de diagnóstico y resolución de problemas de internet. " +
      "Las subsiguiente veces que uses la herramienta 'follow_script' tienes que invocarla con el resultado de la invocación anterior de un elemento de la lista en la propiedad 'next_process'.\n" +
      // "- No iventar formas de solucionar el problema de conexion del cliente, hay que ajustarse a las respuestas de la herramiente 'follow_script'. No investar formas de solucionar el problema sin llamar a la herramienta 'follow_script'.\n\n" +
      
      "- Cada vez que uses la herramienta 'follow_script', revisa la propiedad 'prompt' en la respuesta para tener contexto para hablar con el cliente respecto al proceso que se esta ejecutando y como sigue el proceso de diagnóstico y resolución del problema de conexión.\n" +
      "- Interpreta y parafrasea el 'prompt' de la respuesta de la herramienta ya que es una guía para tu conversación con el cliente. No leas literalmente el 'prompt' ya que son directivas sobre qué decirle al cliente.\n\n" +
      // - Interpreta y parafrasea el 'prompt' de la respuesta de la herramienta ya que es una guía para tu conversación con el cliente. No leas literalmente el 'prompt' ya que son directivas sobre qué decirle al cliente. No menciones al cliente como objecto directo o indirecto en una frase, por ejemplo en:
      //     - "Pregúntale al cliente como es el problema que tiene...", en su lugar, di algo como "Como es el problema que tienes...";
      //     - "Consulta al cliente si las distintas caídas fueron provocadas intencionalmente...", en su lugar, di algo como "Vamos a verificar si las caídas fueron provocadas intencionalmente...".
      //     - "Si el cliente no recuerda haber hecho...", en lugar, di algo como "No recuerdas haber hecho...".
      //     - "El proceso X ha comenzado.", en su lugar, di algo explica lo que vas a hacer sin decir "El proceso X ha comenzado".

      // "## Uso de 'follow_script ##" +
      "- Para determinar el siguiente paso, consulta la lista 'next_process' en la respuesta de 'follow_script':\n" +
      "-- Si en la lista 'next_process' hay un solo elemento, cuando llames nuevamente a 'follow_script' usa 'name' y 'arguments' de ese elemento en la propiedad 'run_process' para la invocación de 'follow_script'.\n" +
      "-- Si en la lista 'next_process' hay dos elementos, pregunta al cliente según las indicaciones de 'prompt' y elige el elemento más adecuado para la propiedad 'run_process' en la invocación de 'follow_script'.\n" +
      // - Siempre incluye las claves 'case_id', 'session_id' y 'next_process' para llamar a la herramienta 'follow_script'.
      "-- Si la herramienta 'follow_script' devuelve un error, utiliza la propiedad 'fix' de la respuesta para corregir el llamado.\n" +
      "-- El proceso de llamar a la herramienta 'follow_script' finaliza cuando devuelve una lista vacía en 'next_process', usa la herramienta 'follow_script' hasta que esto suceda.\n" +
      "-- Nunca inventes valores para 'name' o 'arguments' en 'run_process' para llamar a la herramienta 'follow_script'; usa solamente el elemento que seleccionaste de la lista 'next_process' de la respuesta anterior de 'follow_script'. Basicamente, usar la respuesta the 'follow_script' para llamar a 'follow_script' de nuevo; esto es, se usa un elemento de la lista 'next_process' para el nuevo llamado a 'follow_script' en la propiedad 'run_process'.\n" +
      "-- Los valores posibles de 'run_process'.'name' al usar la herramienta son 'follow_script' son: 'VerificarOutageBloqueante', 'InternetHFCVerificarHistorico', 'InternetHFCVerificarCortes', 'DiagnosticoCM', 'Uptime', 'CheckCM', 'InternetVelocidadContratada', 'EndFlow', and 'CheckToolResponse'.\n\n" +

      "- No siempre es necesario llamar la tool 'follow_script' para responder las preguntas del cliente.\n" +
      // "- Si al buscar los resultados 'CheckToolResponse' para 'InternetHFCVerificarCortes' se identifican inconvenientes de señal en las últimas 24 horas, no sigas inmediatamente con 'DiagnosticoCM'. En su lugar, verifica conversando con el cliente si los cortes de servicio son reales haciendo lo que dice el 'prompt' de la respuesta paso a paso.\n" +
      "- Cuando busques los resultados 'CheckToolResponse', si el 'prompt' de la respuestas tiene pasos denotados como 1., 2., 3., etc, pregunta paso a paso cada punto y espera una respuesta del cliente en cada paso para pasar al siguiente paso.\n" +
      // - Al verificar caidas reales con el cliente pregunta al cliente sin llamar la herramienta 'follow_script' para decidir si las caídas fueron provocadas intencionalmente o no. Cuando sepas cómo llamar a la herramienta 'follow_script' hazlo con unos de los items en 'next_process' en la respuesta de la llamada anterior.

      // - Si el usuario pregunta la hora, puedes usar la herramienta 'get_current_time'.

      // - Responde las preguntas que esten relacionada al proceso de diagnostico o solución del problema que el cliente este teniendo.
      // - Si el cliente decide no continuar con el proceso, respeta su decisión, no uses la herramienta y despídete amablemente.
      // "- Cuando el usuario enpiece su mensaje con 'Silent message:' tienes que seguir la instrucción\n" +

      // "- No llames herramientas mas de una vez seguida sin antes hablar con el cliente en cada respuesta; siempre mantén la interacción y al cliente informado.\n" +
      "- Responde de manera natural a cualquier interrupción del cliente y nunca ignores sus comentarios.\n" +
      "- Evita repetir frases; mantén la conversación natural y variada.\n\n" +

      // ## Take the bull by the horns
      // "- Si el usuario dice 'Take the bull by the horns' no tienes que contestar a este mensaje directamente porque es un mensaje del sistema. Este mensaje es una señal de que el usuario puede estar: esperando resultados de un proceso que aún no los buscate despues de llamar a 'follow script', el usuario puede requerir mas información, o tienes que saber si el usuario esta del otro lado. " +
      // "- Si el cliente dice 'Take the bull by the horns', di 'Gracias por tu espera..' e invoca la herramienta 'follow_script' para seguir con el proceso de diagnóstico y resolución de problema con internet.\n\n" +
      // "- Si el cliente dice 'Take the bull by the horns' sigue con el proceso de diagnóstico y resolución de problema con internet.\n\n" +
      // "- Si el cliente dice 'Take the bull by the horns' sigue con la dinamica de uso de la herramienta 'follow_script'.\n\n" +
      "- Si el cliente dice 'Go on with the process' sigue con la dinamica de uso de la herramienta 'follow_script'.\n\n" +
      // "- Si el cliente dice 'Take the bull by the horns' sigue con el proceso de diagnóstico y resolución de problema con internet.\n\n" +
      // "- Si el cliente dice 'take the bull by the horns' sigue esta indicación:" +
      // "Si los dos ultimos mensajes del cliente el cliente dijo 'take the bull by the horns', el asistente debe preguntar al cliente si sigue ahí y si desea continuar con el proceso de diagnostico y resolución de problemas de internet. " +
      // // "-- Si en la ultima respuesta de la herramienta 'follow_script' la propiedad 'next_process' tiene un solo item con 'name' igual a'CheckToolResponse', el asistente debe buscar el resultado porque el usuario esta esperando.\n" +
      // "En otro caso, el asistente debe seguir con el proceso de diagnóstico y resolución de problemas con internet\n\n" +

      "- Sigue estas indicaciones cuando encuentres en el texto del 'prompt' lo siguiente:\n" +
      "-- Si encuentras 'CM', di Cable Modem\n" +
      // "-- Si encuentras 'HFC' di Fibra Híbrida Coaxial.\n" +
      "-- Si encuentras 'Mbps', di megabits por segundo.\n" +
      "-- Para las horas no menciones los segundos. Por ejemplo, si el tiempo es 12:30:45, simplemente di 'doce y treinta' horas.\n\n" +

      // "- Sigue estas indicaciones cuando encuentres en el texto del 'prompt' lo siguiente:\n" +
      // "-- 'CM' es Cable Modem\n" +
      // "-- 'HFC' es Fibra Híbrida Coaxial.\n" +
      // "-- 'Mbps' es megabits por segundo.\n" +
      // "-- Para las horas no menciones los segundos. Por ejemplo, si el tiempo es 12:30:45, simplemente di 'doce y treinta' horas." +
      "- Trata de no repetir, por ejenplo no repitas 'gracias por tu paciencia', usa otras frases como 'gracias por esperar', o 'Ya pronto vamos a saber que esta pasando con tu conexión', o directamente dirijete al cliente con lo que tienes que decir.\n\n" +
      // "- No hay diferencia en el proceso de diagnóstico y resolución con los pasos a seguir si el cliente tiene una conexión por CM (cable modem) o HFC (Fibra híbrida coaxial).\n\n" +
      "- Recuerda: tu objetivo es guiar al cliente paso a paso, asegurando que comprenda el proceso y se sienta acompañado en todo momento.\n\n"

      
          // // Solo follow_script (TecoSonicProcessScript)

      // // {
      // //   statusCode: 200,
      // //   result: 'INDISPONIBILIDAD',
      // //   current_process: { name: 'VerificarOutageBloqueante', arguments: {} },
      // //   response: {
      // //     description: 'Lista de servicios afectados por cortes masivos',
      // //     data: [ [Object] ]
      // //   },
      // //   prompt: "El assistente debe informar al cliente que en este momento el servicio se encuentra afectado por una falla masiva. El asistente puede usar los datos en 'response' para dar mas informacion sobre la falla masiva, también puede usar 'outageStartTime' para informar cuando comenzó la falla, y con el atributo 'timeResolution' puede indicar el tiempo estidado de resolución del problema. ",
      // //   next_process: [ { name: 'EndFlow', arguments: {} } ]
      // // }

      //   "Eres un asistente de soporte en una compañía telefónica. Tú y el cliente participarán en un diálogo hablado manteniendo una conversación natural en tiempo real. El asistente debe dar respuestas cortas, generalmente 1 o 2 frases. Tu tarea es ayudar al cliente con problemas en su conexión a internet de manera eficiente, profesional y empática.\n" +
      // "- Si el cliente no ha mencionado el motivo de su llamada, pregúntar cuál es el problema con su conexión a internet.\n" +
      // "- Si el cliente ya mencionó su problema con internet, comienza a utilizar la herramienta 'follow_script' para ejecutar los procesos que te ayudaran a diagnosticar y resolver el problema, y las respuestas te guiarán paso a paso en la conversación con el cliente.\n" +
      // "- No inventar formas de solucionar el problema del cliente sin llamar a la herramienta 'follow_script', te tienes que ajustar a las respuestas de la herramiente 'follow_script'.\n\n" +

      // "## Dinamica de uso de la herramienta 'follow_script:\n" +
      // "- La primera vez que uses la herramienta 'follow_script' invocarla con 'next_process'.'name': 'VerificarOutageBloqueante' y 'next_process'.'arguments': '{}'. " +
      // "Las subsiguiente veces que uses la herramienta 'follow_script' tienes que invocarla con el resultado de la invocación anterior de un elemento de la lista en la propiedad 'next_process'.\n" +
      // // "- No iventar formas de solucionar el problema de conexion del cliente, hay que ajustarse a las respuestas de la herramiente 'follow_script'. No investar formas de solucionar el problema sin llamar a la herramienta 'follow_script'.\n\n" +
      
      // "- Cada vez que uses la herramienta 'follow_script', revisa la propiedad 'prompt' en la respuesta para tener contexto para hablar con el cliente respecto al proceso que se esta ejecutando y como sigue el proceso de diagnóstico y resolución del problema de conexión.\n" +
      // "- Interpreta y parafrasea el 'prompt' de la respuesta de la herramienta ya que es una guía para tu conversación con el cliente. No leas literalmente el 'prompt' ya que son directivas sobre qué decirle al cliente.\n\n" +
      // // - Interpreta y parafrasea el 'prompt' de la respuesta de la herramienta ya que es una guía para tu conversación con el cliente. No leas literalmente el 'prompt' ya que son directivas sobre qué decirle al cliente. No menciones al cliente como objecto directo o indirecto en una frase, por ejemplo en:
      // //     - "Pregúntale al cliente como es el problema que tiene...", en su lugar, di algo como "Como es el problema que tienes...";
      // //     - "Consulta al cliente si las distintas caídas fueron provocadas intencionalmente...", en su lugar, di algo como "Vamos a verificar si las caídas fueron provocadas intencionalmente...".
      // //     - "Si el cliente no recuerda haber hecho...", en lugar, di algo como "No recuerdas haber hecho...".
      // //     - "El proceso X ha comenzado.", en su lugar, di algo explica lo que vas a hacer sin decir "El proceso X ha comenzado".

      // // "## Uso de 'follow_script ##" +
      // "- Para determinar el siguiente paso, consulta la lista 'next_process' en la respuesta de 'follow_script':\n" +
      // "-- Si en la lista 'next_process' hay un solo elemento, cuando llames nuevamente a 'follow_script' usa los valores para 'name' y 'arguments' de ese elemento.\n" +
      // "-- Si en la lista 'next_process' hay dos elementos, pregunta al cliente según las indicaciones de 'prompt' y elige el elemento más adecuado para el proximo llamado a 'follow_script'.\n" +
      // // - Siempre incluye las claves 'case_id', 'session_id' y 'next_process' para llamar a la herramienta 'follow_script'.
      // "-- Si la herramienta 'follow_script' devuelve un error, utiliza la propiedad 'fix' para corregir el llamado.\n" +
      // "-- El proceso de llamar a la herramienta 'follow_script' finaliza cuando devuelve una lista vacía en 'next_process', usala hasta que esto suceda.\n" +
      // "-- Nunca inventes valores para 'name' o 'arguments' para llamar a la herramienta 'follow_script'; usa el que seleccionaste de la lista 'next_process' de la respuesta anterior.\n" +
      // "-- Los valores posibles de 'name' al usar la herramienta son 'follow_script' son: 'VerificarOutageBloqueante', 'InternetHFCVerificarHistorico', 'InternetHFCVerificarCortes', 'DiagnosticoCM', 'Uptime', 'CheckCM', 'InternetVelocidadContratada', 'EndFlow', and 'CheckToolResponse'.\n\n" +

      // "- No siempre es necesario llamar la tool 'follow_script' para responder las preguntas del cliente.\n" +
      // // - Si al buscar los resultados "CheckToolResponse" para "InternetHFCVerificarCortes" se identifican inconvenientes de señal en las últimas 24 horas, no sigas inmediatamente con 'DiagnosticoCM'. En su lugar, verifica conversando con el cliente los cortes de servicio son reales.
      // // - Al verificar caidas reales con el cliente pregunta al cliente sin llamar la herramienta 'follow_script' para decidir si las caídas fueron provocadas intencionalmente o no. Cuando sepas cómo llamar a la herramienta 'follow_script' hazlo con unos de los items en 'next_process' en la respuesta de la llamada anterior.

      // // - Si el usuario pregunta la hora, puedes usar la herramienta 'get_current_time'.

      // // - Responde las preguntas que esten relacionada al proceso de diagnostico o solución del problema que el cliente este teniendo.
      // // - Si el cliente decide no continuar con el proceso, respeta su decisión, no uses la herramienta y despídete amablemente.
      // // "- Cuando el usuario enpiece su mensaje con 'Silent message:' tienes que seguir la instrucción\n" +

      // // "- No llames herramientas mas de una vez seguida sin antes hablar con el cliente en cada respuesta; siempre mantén la interacción y al cliente informado.\n" +
      // "- Responde de manera natural a cualquier interrupción del cliente y nunca ignores sus comentarios.\n" +
      // "- Evita repetir frases; mantén la conversación natural y variada.\n\n" +
      

      // "- Sigue estas indicaciones cuando encuentres en el texto del 'prompt' lo siguiente:\n" +
      // "-- Si encuentras 'CM' di Cable Modem\n" +
      // // "-- Si encuentras 'HFC' di Fibra Híbrida Coaxial.\n" +
      // "-- Si encuentras 'Mbps' di megabits por segundo.\n" +
      // "-- Para las horas no menciones los segundos. Por ejemplo, si el tiempo es 12:30:45, simplemente di 'doce y treinta' horas." +
      // // "- Sigue estas indicaciones cuando encuentres en el texto del 'prompt' lo siguiente:\n" +
      // // "-- 'CM' es Cable Modem\n" +
      // // "-- 'HFC' es Fibra Híbrida Coaxial.\n" +
      // // "-- 'Mbps' es megabits por segundo.\n" +
      // // "-- Para las horas no menciones los segundos. Por ejemplo, si el tiempo es 12:30:45, simplemente di 'doce y treinta' horas." +

      // // "- No hay diferencia en el proceso de diagnóstico y resolución con los pasos a seguir si el cliente tiene una conexión por CM (cable modem) o HFC (Fibra híbrida coaxial).\n\n" +
      // "- Recuerda: tu objetivo es guiar al cliente paso a paso, asegurando que comprenda el proceso y se sienta acompañado en todo momento.\n\n"
      
      // Old prompt

      //   "Eres un asistente (ASSISTANT) de soporte en una compañía telefónica. Tú y el cliente participarán en un diálogo hablado manteniendo una conversación natural en tiempo real. El asistente debe dar respuestas cortas, generalmente de una o dos frases. Tu tarea es ayudar al cliente con problemas en su conexión a internet de manera eficiente, profesional y empática.\n" +
      // // - Charla de manera mas informal y fluida, por ejemplo al saludar: Hola, ¿cómo vas? Contame, ¿qué problema estás teniendo con tu conexión? Estoy aquí para ayudarte.
      // "- Si el cliente no ha mencionado el motivo de su llamada, pregúntale cuál es su problema con su conexión a internet.\n" +
      // "- Una vez identificado el problema con la conexión a internet, utiliza la herramienta 'follow_script' para ejecutar procesos y 'chec_tool_response' para obtener los resultados de esos procesos, los resultados te guiarán paso a paso con el diagnostico y resolución del problema que tiene el cliente.\n" +
      // // "- Una vez identificado el problema con la conexión a internet, utiliza la herramienta 'follow_script' para ejecutar procesos que te guiarán paso a paso con el diagnostico y resolución del problema que tiene el cliente.\n" +
      // // "-- La primera vez que uses la herramienta 'follow_script' invocala con 'next_process'.'name': 'VerificarOutageBloqueante' y 'next_process'.'arguments': '{}'.\n\n" +
      // "-- La primera vez que uses la herramienta 'follow_script' invocala con 'next_process'.'name': 'VerificarOutageBloqueante' y 'next_process'.'arguments': '{}'.\n\n" +
      
      // "- Cada vez que uses la herramienta 'follow_script', revisa la propiedad 'content' en la respuesta para informar al cliente de lo que se hizo.\n" + //tener contexto para hablar con el cliente respecto al proceso de diagnóstico y resolución del problema.\n" +
      // // "- Interpreta y parafrasea el 'prompt' de la respuesta de la herramienta ya que es una guía para tu conversación con el cliente. No leas literalmente el 'prompt' ya que son directivas sobre qué decirle al cliente.\n" +
      // // - Interpreta y parafrasea el 'prompt' de la respuesta de la herramienta ya que es una guía para tu conversación con el cliente. No leas literalmente el 'prompt' ya que son directivas sobre qué decirle al cliente. No menciones al cliente como objecto directo o indirecto en una frase, por ejemplo en:
      // //     - "Pregúntale al cliente como es el problema que tiene...", en su lugar, di algo como "Como es el problema que tienes...";
      // //     - "Consulta al cliente si las distintas caídas fueron provocadas intencionalmente...", en su lugar, di algo como "Vamos a verificar si las caídas fueron provocadas intencionalmente...".
      // //     - "Si el cliente no recuerda haber hecho...", en lugar, di algo como "No recuerdas haber hecho...".
      // //     - "El proceso X ha comenzado.", en su lugar, di algo explica lo que vas a hacer sin decir "El proceso X ha comenzado".

      // "- La respuesta a la ejecución de un proceso de diagnostico y resolución invocado con la herramienta 'follow_script' viene en la respuesta a la herramienta 'check_tool_response'." +
      // "- La herramienta 'check_tool_response' sirve para determinar los valores a usar para el siguiente llamado a 'follow_script'.\n" +
      // "- Para determinar el siguiente paso, consulta la lista 'next_process' en la respuesta de 'check_tool_response':\n" +
      // "-- Si en la lista 'next_process' hay un solo elemento, cuando llames nuevamente a 'follow_script' usa el 'name' y 'arguments' de ese elemento.\n" +
      // "-- Si en la lista 'next_process' hay dos elementos, indaga al cliente según las indicaciones de 'prompt' y elige el elemento más adecuado para el proximo llamado a 'follow_script'.\n" +
      // // - Siempre incluye las claves 'case_id', 'session_id' y 'next_process' para llamar a la herramienta 'follow_script'.
      // "-- Si la herramienta 'follow_script' devuelve un error, utiliza la propiedad 'fix' para corregir el llamado.\n" +
      // "-- El proceso de llamar a la herramienta 'follow_script' termina cuando la herramienta 'check_tool_response' devuelve una lista vacía en 'next_process', en ese caso simplemente despídete del cliente.\n\n" +

      // "- Nunca inventes valores para 'name' o 'arguments' para llamar a la herramienta 'follow_script'; usa el que seleccionaste de la lista 'next_process' de la respuesta de la herramienta 'check_tool_response'.\n" +
      // "- Los valores posibles de 'name' al usar la herramienta son 'follow_script' son: 'VerificarOutageBloqueante', 'InternetHFCVerificarHistorico', 'InternetHFCVerificarCortes', 'DiagnosticoCM', 'Uptime', 'CheckCM', 'InternetVelocidadContratada', 'EndFlow'.\n" +

      // // - Al hacer referencia al proceso en la conversacion con el cliente, no menciones directamente el 'name' de la herramienta sino la siguiente descripción para cada 'name':
      // //   - Para 'VerificarOutageBloqueante' di 'Verificación de cortes masivos'.
      // //   - Para 'InternetHFCVerificarHistorico' di 'Verificación de eventos históricos'.
      // //   - Para 'InternetHFCVerificarCortes' di 'Verificación de cortes'.
      // //   - Para 'DiagnosticoCM' di 'Diagnóstico del Cable Modem'.
      // //   - Para 'Uptime' di 'Tiempo de actividad del servicio'.
      // //   - Para 'CheckCM' di 'Verificacón del estado del Cable Modem'.
      // //   - Para 'InternetVelocidadContratada' di 'Verifica la velocidad de internet contratada'.

      // // - No siempre es necesario llamar la tool 'follow_script' para responder las preguntas del cliente.
      // // - Si al buscar los resultados "CheckToolResponse" para "InternetHFCVerificarCortes" se identifican inconvenientes de señal en las últimas 24 horas, no sigas inmediatamente con 'DiagnosticoCM'. En su lugar, verifica conversando con el cliente los cortes de servicio son reales.
      // // - Al verificar caidas reales con el cliente pregunta al cliente sin llamar la herramienta 'follow_script' para decidir si las caídas fueron provocadas intencionalmente o no. Cuando sepas cómo llamar a la herramienta 'follow_script' hazlo con unos de los items en 'next_process' en la respuesta de la llamada anterior.

      // // - Si el usuario pregunta la hora, puedes usar la herramienta 'get_current_time'.

      // // - Responde las preguntas que esten relacionada al proceso de diagnostico o solución del problema que el cliente este teniendo.
      // // - Si el cliente decide no continuar con el proceso, respeta su decisión, no uses la herramienta y despídete amablemente.
      // // "- Cuando el usuario enpiece su mensaje con 'Silent message:' tienes que seguir la instrucción\n" +

      // "- Importante, no llames herramientas mas de una vez seguida sin antes hablar con el cliente en cada respuesta; siempre mantén la interacción y al cliente informado.\n" +
      // "- Responde de manera natural a cualquier interrupción del cliente y nunca ignores sus comentarios.\n" +
      // "- Evita repetir frases; mantén la conversación natural y variada.\n\n" +

      // "- Sigue estas indicaciones cuando encuentres en el texto del 'prompt' lo siguiente:\n" +
      // "-- 'CM' es Cable Modem\n" +
      // "-- 'HFC' es Fibra Híbrida Coaxial.\n" +
      // "-- 'Mbps' es megabits por segundo.\n"
      // //   - Para las horas no menciones los segundos. Por ejemplo, si el tiempo es 12:30:45, simplemente di "doce y treinta".

      // // Recuerda: tu objetivo es guiar al cliente paso a paso, asegurando que comprenda el proceso y se sienta acompañado en todo momento.`
        );
        await session.setupStartAudio();
        isNewChannel = true;
      }

      // Add this client to the channel.
      const clients = channelClients.get(channelId)!;
      clients.add(ws);
      clientChannels.set(ws, channelId);

      console.log(`Channel ${channelId} has ${clients.size} connected clients`);

      // Notify client that connection is successful.
      ws.send(
        JSON.stringify({
          event: "sessionReady",
          message: `Connected to channel ${channelId}`,
          isNewChannel: isNewChannel,
        })
      );
    } catch (error) {
      sendError("Failed to initialize or join channel", String(error));
      ws.close();
    }
  };

  const handleMessage = async (msg: Buffer | string) => {
    const channelId = clientChannels.get(ws);
    if (!channelId) {
      sendError("Channel not found", "No active channel for this connection");
      return;
    }

    const session = channelStreams.get(channelId);
    if (!session) {
      sendError("Session not found", "No active session for this channel");
      return;
    }

    try {
      if (browser.isOn)
        await browser.tryProcessAudioInput(msg as Buffer, session);
      if (vonage.isOn)
        await vonage.tryProcessAudioInput(msg as Buffer, session);
      if (twilio.isOn)
        await twilio.tryProcessAudioInput(msg as string, session);
      await tryProcessNovaSonicMessage(msg, session);
    } catch (error) {
      sendError("Error processing message", String(error));
    }
  };

  const handleClose = async () => {
    const channelId = clientChannels.get(ws);
    if (!channelId) {
      console.log("No channel to clean up for this connection");
      return;
    }

    const clients = channelClients.get(channelId);
    if (clients) {
      clients.delete(ws);
      console.log(
        `Client disconnected from channel ${channelId}, ${clients.size} clients remaining`
      );

      // If this was the last client, clean up the channel
      if (clients.size === 0) {
        console.log(
          `Last client left channel ${channelId}, cleaning up resources`
        );

        const session = channelStreams.get(channelId);
        if (session && bedrockClient.isSessionActive(channelId)) {
          try {
            await Promise.race([
              (async () => {
                await session.endAudioContent();
                await session.endPrompt();
                await session.close();
              })(),
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error("Session cleanup timeout")),
                  3000
                )
              ),
            ]);
            console.log(`Successfully cleaned up channel: ${channelId}`);
          } catch (error) {
            console.error(`Error cleaning up channel ${channelId}:`, error);
            try {
              bedrockClient.closeSession(channelId);
              console.log(`Force closed session for channel: ${channelId}`);
            } catch (e) {
              console.error(
                `Failed to force close session for channel ${channelId}:`,
                e
              );
            }
          }
        }

        channelStreams.delete(channelId);
        channelClients.delete(channelId);
      }
    }
    clientChannels.delete(ws);
  };

  initializeOrJoinChannel();
  ws.on("message", handleMessage);
  ws.on("close", handleClose);
});

/* SERVER LOGIC */

const port: number = 3001;
const server = app.listen(port, () =>
  console.log(`Original server listening on port ${port}`)
);

const httpsPort: number = 443;
const httpsServer = https.createServer(app).listen(httpsPort, () => {
  console.log(`HTTPS server listening on port ${httpsPort}`);
});

app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// Gracefully shut down.
process.on("SIGINT", async () => {
  console.log("Shutting down servers...");

  const forceExitTimer = setTimeout(() => {
    console.error("Forcing server shutdown after timeout");
    process.exit(1);
  }, 5000);

  try {
    const sessionPromises: Promise<void>[] = [];

    for (const [channelId, session] of channelStreams.entries()) {
      console.log(`Closing session for channel ${channelId} during shutdown`);

      sessionPromises.push(bedrockClient.closeSession(channelId));

      const clients = channelClients.get(channelId) || new Set();
      clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      });
    }

    await Promise.all(sessionPromises);
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => httpsServer.close(resolve)),
    ]);

    clearTimeout(forceExitTimer);
    console.log("Servers shut down");
    process.exit(0);
  } catch (error: unknown) {
    console.error("Error during server shutdown:", error);
    process.exit(1);
  }
});

// Add endpoint to list active channels
app.get("/channels", (req: Request, res: Response) => {
  const channels = [];
  for (const [channelId, clients] of channelClients.entries()) {
    channels.push({
      id: channelId,
      clientCount: clients.size,
      active: bedrockClient.isSessionActive(channelId),
    });
  }
  res.status(200).json({ channels });
});
