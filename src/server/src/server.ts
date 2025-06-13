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
// import { GenesysIntegration } from "./telephony/genesys";

const app = express();
const wsInstance = expressWs(app);
app.use(bodyParser.json());

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
        // await session.setupSystemPrompt(
        //   undefined,
        //   `You are Telly, an AI assistant having a voice conversation. Keep responses concise and conversational.
        //   You must always check what the next script item is, and you must always use the script as a starting
        //   point to decide what to respond the user and what tools to use. You must always rely on your script
        //   to find what to say. You must not change or embellish the script; just present the script to the user,
        //   and present them with their options if there are any. No matter what the user says, you should start
        //   by checking the script. You must not tell the user about the script. You must always present the options
        //   to the user with numbers. If the script tells you to check your tools, you are then allowed to deviate
        //   from the script.
        //   Before every response to the user, you MUST check if you have any messages to pass on to the user.
        //   `
        // );

        // const CONVERSATION_SESSION_ID = "Sonic02";
        // const CONVERSATION_CASE_ID = "02";

        await session.setupSystemPrompt(
          undefined,
          `Eres un agente de una compañía telefónica. El cliente te hablará ` +
            `por problemas en su connección a internet que tu compañía telefónica brinda.  ` +
            `Responde de manera corta y concisa, generalmente entre 2 o 3 frases ya que tu conversación con el cliente debe ser fluida. ` +
            // `Estas son las variables que mantendrás para toda la conversación con el cliente: 'session_id': '${CONVERSATION_SESSION_ID}', 'case_id': '${CONVERSATION_CASE_ID}'. \n` +
            `Despues de saludar al cliente, la primera accion que tienes que hacer es usar la tool 'follow_script' para correr un proceso con 'name': 'VerificarOutageBloqueante' y 'arguments': '{}'. ` +
            `Esta herramienta permite seguir un proceso estructurado para diagnosticar y resolver problemas de conexión a internet de manera eficiente. ` +
            // `Usa la respuesta de la tool, lo que esta en 'prompt' para dar al cliente más información sobre que tienes que hacer para solucionar el problema con la conexion a internet. ` +

            `Cada vez que llamas a la tool 'follow_script' tienes que buscar en su respuesta la propiedad 'prompt' para saber qué decir al cliente. Además, para saber qué paso seguir, usa ` +
            `la informacion que viene en la propiedad 'next_process' que es una lista. ` +
            `Si la lista tiene un solo item, el próximo llamado a la tool 'follow_script' la tienes que hacer con 'name' y 'arguments' provistos en ese item. ` +
            `Pero, si la lista tiene más de un item tienes que decidir qué item de la lista usar siguiendo las indicaciones en la propiedad ` +
            `'prompt'. En este caso, tienes que indagar al cliente y decidir qué item es el más apropiado para el siguiente paso. ` +
            `Asegurate siempre de llamar a la tool con estas keys requeridas: 'case_id', 'session_id', and 'next_process'. ` +
            `Si la tool 'follow_script' devuelve un error, usa la propiedad 'fix' para corregir el error en el llamado. ` +
            `Nunca inventes los valores para 'name' o 'arguments' al llamar a la tool 'follow_script', tienes que usar solamente aquellos que vienen en el item de la lista en la propiedad 'next_process' que tienes que elegir. ` +
            `Para la tool 'follow_script', los valores posibles de 'name' son 'VerificarOutageBloqueante', 'InternetHFCVerificarHistorico', 'InternetHFCVerificarCortes', 'DiagnosticoCM', 'Uptime', 'CheckCM', 'InternetVelocidadContratada', 'EndFlow', y 'CheckToolResponse'. ` +
            `\nAlgunas abreviaciones: CM: Cable Modem, HFC: Hybrid Fiber Coaxial, Mbps: megabits por segundos. ` +
            `\nNo llames a la tool de manera consecutiva sin hablar con el cliente, siempre tienes que hablar con el cliente antes de volver a llamar a la tool. ` +
            `\nLa tool siempre se llama con 'session_id', 'case_id' y 'next_process'. `
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
