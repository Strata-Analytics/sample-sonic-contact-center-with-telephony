import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

import config from "./config";

function initializeBedrockClient() {
  return new BedrockRuntimeClient({
    region: config.aws.region,
    credentials: {
      accessKeyId: config.aws.accessKeyId,
      secretAccessKey: config.aws.secretAccessKey,
      sessionToken: config.aws.sessionToken, // Optional, include if you're using temporary credentials
    },
  });
}

/**
 * Analyze sentiment of the latest user message using Bedrock
 * @param {string} message - The user's message text to analyze
 * @returns {Promise<number>} - Sentiment score from 0-100
 */
async function analyzeSentiment(message) {
  try {
    const client = initializeBedrockClient();
    console.log("client", client);

    const command = new ConverseCommand({
      modelId: "amazon.nova-lite-v1:0",
      messages: [
        {
          role: "user",
          content: [
            {
              text: `Analyze the sentiment of this message and return only a number between 0 and 100, where 0 to 33 is extremely, 33-66 is neutral, and 66 to 100 is positive. This means 0 is extremely negative and 100 is extremely positive. Only return the number, no other text: "${message}"`,
            },
          ],
        },
      ],
    });
    const response = await client.send(command);
    console.debug("Bedrock sentiment response:", response);

    // Extract the sentiment score from the response
    const sentimentText = response.output.message.content[0].text.trim();
    const sentimentScore = parseInt(sentimentText, 10);

    if (isNaN(sentimentScore)) {
      console.error("Failed to parse sentiment score:", sentimentText);
      return 50; // Default to neutral if parsing fails
    }

    console.log("Bedrock sentiment analysis result:", sentimentScore);
    return sentimentScore;
  } catch (error) {
    console.error("Error analyzing sentiment with Amazon Bedrock:", error);
    // On error, return a neutral value
    return 50;
  }
}

/**
 * Generate insights based on the full conversation history using Bedrock
 * @param {Array} history - Full conversation history array
 * @returns {Promise<string>} - A single insight string
 */
async function generateInsight(history) {
  try {
    if (!history || history.length === 0) return "";

    const client = initializeBedrockClient();
    const formattedHistory = history
      .map((msg) => `${msg.sender === "user" ? "User" : "Agent"}: ${msg.text}`)
      .join("\n");

    const input = {
      modelId: "amazon.nova-lite-v1:0",
      messages: [
        {
          role: "user",
          content: [
            {
              text: `Tu trabajo es analizar la conversación del agente hasta este punto y proporcionar retroalimentación accionable sobre cómo puede asistir mejor a su cliente. Basado en esta conversación, proporciona una sola idea breve sobre el sentimiento del cliente, sus necesidades o la calidad de la interacción. Debes redactar estas sugerencias como recomendaciones para el agente.

          Guías de Política de la Compañía de Telecomunicaciones:
          - Si el cliente hace preguntas no relacionadas con nuestros servicios o productos de telecomunicaciones, redirígelo amablemente a temas relevantes.
          - Para preguntas personales fuera de tema, los agentes deben responder: "Con gusto te ayudo con preguntas sobre nuestros servicios de telecomunicaciones, planes o soporte técnico" antes de reenfocar la conversación.
          - Nunca participes en temas políticamente divisivos, en su lugar di: "Entiendo tu interés, pero enfoquémonos en cómo puedo ayudarte con tus necesidades de servicio móvil/internet/TV hoy."
          - Para solicitudes inapropiadas, rechaza amablemente y ofrece alternativas de asistencia relacionadas con telecomunicaciones.
          - Para preguntas sobre servicios de la competencia, reconoce la pregunta pero reenfoca en las ofertas de nuestra compañía sin desacreditar a los competidores.

          Devuelve solo la idea/sugerencia sin explicaciones ni contexto. No generes nada más que la idea/sugerencia.

          Ejemplos de ideas:
          - "El cliente parece frustrado por la baja velocidad de internet. Considera ofrecer una prueba de velocidad y pasos de solución de problemas."
          - "Cuando el cliente preguntó sobre noticias políticas, podrías haber redirigido de manera más fluida reconociendo y luego reenfocando en sus necesidades de cuenta."
          - "El cliente parece confundido sobre la estructura de nuestros planes de datos. Considera compartir un desglose sencillo de nuestras opciones por niveles."
          - "Considera ofrecer proactivamente información sobre la cobertura de nuestra red en el área del cliente según sus inquietudes."

          Conversación:
          ${formattedHistory}`,
            },
          ],
        },
      ],
    };

    const command = new ConverseCommand(input);
    const response = await client.send(command);

    // Extract just the insight
    const insight = response.output.message.content[0].text.trim();
    console.log("Bedrock insight generation result:", insight);
    return insight;
  } catch (error) {
    console.error("Error generating insight with Amazon Bedrock:", error);
    return "";
  }
}

export { analyzeSentiment, generateInsight };
