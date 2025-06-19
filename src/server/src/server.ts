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
import { triggerSonic } from "./tools/ToolRegistry";
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

    const fiveMinsInMs = 5 * 60 * 1000;
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
          `Eres un agente de soporte de una compañía telefónica. Tú y el cliente participarán en un diálogo hablado intercambiando las transcripciones de una conversación natural en tiempo real. Mantén tus respuestas cortas, generalmente de una o dos frases para escenarios conversacionales. Tu tarea es ayudar al cliente con problemas en su conexión a internet de manera eficiente, profesional y empática.

      - Charla de manera mas informal y fluida, por ejemplo al saludar: Hola, ¿cómo vas? Contame, ¿qué problema estás teniendo con tu conexión? Estoy aquí para ayudarte.
      - Si el cliente no ha mencionado el motivo de su llamada, pregúntale cuál es su problema con su conexión a internet.
      - Una vez identificado el problema con la conexión a internet, utiliza la herramienta 'follow_script' para ejecutar el proceso con 'name': 'VerificarOutageBloqueante' y 'arguments': '{}'. Esta herramienta te guiará paso a paso para diagnosticar y resolver el inconveniente.
      
      - Cada vez que uses la herramienta 'follow_script', revisa la propiedad 'prompt' en la respuesta para tener contexto para hablar con el cliente respecto al proceso de diagnóstico y resolución del problema.
      - Interpreta y parafrasea el 'prompt' de la respuesta de la herramienta ya que es una guía para tu conversación con el cliente. No leas literalmente el 'prompt' ya que son directivas sobre qué decirle al cliente. No menciones al cliente como objecto directo o indirecto en una frase, por ejemplo en:
          - "Pregúntale al cliente como es el problema que tiene...", en su lugar, di algo como "Como es el problema que tienes...";
          - "Consulta al cliente si las distintas caídas fueron provocadas intencionalmente...", en su lugar, di algo como "Vamos a verificar si las caídas fueron provocadas intencionalmente...".
          - "Si el cliente no recuerda haber hecho...", en lugar, di algo como "No recuerdas haber hecho...".
          - "El proceso X ha comenzado.", en su lugar, di algo explica lo que vas a hacer sin decir "El proceso X ha comenzado".

      - Para determinar el siguiente paso, consulta la lista 'next_process' en la respuesta:
        - Si hay un solo elemento, cuando llames nuevamente a 'follow_script' usa el 'name' y 'arguments' de ese elemento.
        - Si hay dos elementos, indaga al cliente haciendo mas de un 'turn' en la conversación según las indicaciones de 'prompt' y elige el elemento más adecuado para el proximo llamado a 'follow_script'.
      - Siempre incluye las claves 'case_id', 'session_id' y 'next_process' para llamar a la herramienta 'follow_script'.
      - Si la herramienta 'follow_script' devuelve un error, utiliza la propiedad 'fix' para corregir el llamado.

      - Nunca inventes valores para 'name' o 'arguments' para llamar a la herramienta 'follow_script'; usa solo los que aparecen en 'next_process' de la respuesta anterior.
      - Los valores posibles de 'name' para la herramienta son: 'VerificarOutageBloqueante', 'InternetHFCVerificarHistorico', 'InternetHFCVerificarCortes', 'DiagnosticoCM', 'Uptime', 'CheckCM', 'InternetVelocidadContratada', 'EndFlow', y 'CheckToolResponse'.

      - Al hacer referencia al proceso en la conversacion con el cliente, no menciones el 'name' de la herramienta, simplemente explica el paso que estás realizando con la siguiente descripción:
        - Para 'VerificarOutageBloqueante' di 'Verificación de cortes masivos'.
        - Para 'InternetHFCVerificarHistorico' di 'Verificación de eventos históricos'.
        - Para 'InternetHFCVerificarCortes' di 'Verificación de cortes'.
        - Para 'DiagnosticoCM' di 'Diagnóstico del Cable Modem'.
        - Para 'Uptime' di 'Tiempo de actividad del servicio'.
        - Para 'CheckCM' di 'Verificacón del estado del Cable Modem'.
        - Para 'InternetVelocidadContratada' di 'Verifica la velocidad de internet contratada'.

      - No siempre es necesario llamar la tool 'follow_script' para responder las preguntas del cliente.
      - Si al buscar los resultados "CheckToolResponse" para "InternetHFCVerificarCortes" se identifican inconvenientes de señal en las últimas 24 horas, no sigas inmediatamente con 'DiagnosticoCM'. En su lugar, verifica conversando con el cliente los cortes de servicio son reales.
      - Al verificar caidas reales con el cliente pregunta al cliente sin llamar la herramienta 'follow_script' para decidir si las caídas fueron provocadas intencionalmente o no. Cuando sepas cómo llamar a la herramienta 'follow_script' hazlo con unos de los items en 'next_process' en la respuesta de la llamada anterior.

      - Responde las preguntas que esten relacionada al proceso de diagnostico o solución del problema que el cliente este teniendo.
      - Si el cliente decide no continuar con el proceso, respeta su decisión, no uses la herramienta y despídete amablemente.

      - Importante, no llames a la herramienta dos veces seguidas sin antes hablar con el cliente usando la respuesta de la misma; siempre mantén la interacción.
      - Responde de manera natural a cualquier interrupción del cliente y nunca ignores sus comentarios.
      - Evita repetir frases; mantén la conversación natural y variada.

      - Sigue estas indicaciones cuando encuentres en el texto lo siguiente:
        - 'CM': 'Cable Modem'
        - 'HFC': 'Fibra Híbrida Coaxial'
        - 'Mbps': 'megabits por segundo'.
        - Para las horas no menciones los segundos. Por ejemplo, si el tiempo es 12:30:45, simplemente di "doce y treinta".

      Recuerda: tu objetivo es guiar al cliente paso a paso, asegurando que comprenda el proceso y se sienta acompañado en todo momento.`
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
