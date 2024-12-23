import { Express, Request, Response } from "express";
import OpenAI from "openai";
import { Assistant } from "openai/resources/beta/assistants";
import { Thread } from "openai/resources/beta/threads/threads";
import { createThread } from "../core/createThread.js";
import { createRun } from "../core/createRun.js";
import { performRun } from "../core/performRun.js";
import { ChatThread } from "../models/ChatThread.js";
import { authenticateUser, AuthenticatedRequest } from "../middleware/auth.js";
import {
  createThreadValidator,
  sendMessageValidator,
  threadHistoryValidator,
  deleteThreadValidator,
} from "../validators/chatValidators.js";

interface SendMessageRequest extends AuthenticatedRequest {
  body: {
    message: string;
    threadId: string;
  };
}

export function setupChatRoutes(
  app: Express,
  client: OpenAI,
  assistant: Assistant
) {
  // Create a new chat thread (protected)
  app.post(
    "/api/chat/thread",
    authenticateUser,
    createThreadValidator,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!req.user?.walletAddress) {
          return res.status(401).json({ error: "Authentication required" });
        }

        // Create OpenAI thread
        const openAiThread = await createThread(client);
        if (!openAiThread?.id) {
          throw new Error("Failed to create OpenAI thread");
        }

        // Create MongoDB thread
        const chatThread = await ChatThread.create({
          userId: req.user.walletAddress,
          threadId: openAiThread.id,
          messages: [],
        });

        res.json({
          threadId: chatThread.threadId,
          createdAt: chatThread.createdAt,
        });
      } catch (error) {
        console.error("Error creating thread:", error);
        res.status(500).json({
          error: "Failed to create chat thread",
          details: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  // Send a message and get a response (protected)
  app.post(
    "/api/chat/message",
    authenticateUser,
    sendMessageValidator,
    async (req: SendMessageRequest, res: Response) => {
      try {
        const { message, threadId } = req.body;

        // Find the thread in MongoDB and verify ownership
        const chatThread = await ChatThread.findOne({
          threadId,
          userId: req.user?.walletAddress,
          isActive: true,
        });

        if (!chatThread) {
          return res
            .status(404)
            .json({ error: "Thread not found or unauthorized" });
        }

        // Verify thread exists in OpenAI
        try {
          const openAiThread = await client.beta.threads.retrieve(threadId);
          if (!openAiThread?.id) {
            throw new Error("OpenAI thread not found");
          }
        } catch (error) {
          console.error("Error retrieving OpenAI thread:", error);
          return res.status(404).json({
            error: "Thread not found in OpenAI",
            details: error instanceof Error ? error.message : "Unknown error",
          });
        }

        // Add user message to OpenAI thread
        await client.beta.threads.messages.create(threadId, {
          role: "user",
          content: message,
        });

        // Save user message to MongoDB
        chatThread.messages.push({
          role: "user",
          content: message,
          createdAt: new Date(),
        });

        // Create and perform the run
        const openAiThread = await client.beta.threads.retrieve(threadId);
        const run = await createRun(client, openAiThread, assistant.id);
        const result = await performRun(run, client, openAiThread);

        if (result?.type === "text") {
          // Save assistant's response to MongoDB
          chatThread.messages.push({
            role: "assistant",
            content: result.text.value,
            createdAt: new Date(),
          });
          await chatThread.save();

          res.json({
            response: result.text.value,
            threadId: chatThread.threadId,
          });
        } else {
          throw new Error("No valid response generated");
        }
      } catch (error) {
        console.error("Error processing message:", error);
        res.status(500).json({
          error: "Failed to process message",
          details: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  // Get user's chat threads (protected)
  app.get(
    "/api/chat/threads",
    authenticateUser,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!req.user?.walletAddress) {
          return res.status(401).json({ error: "Authentication required" });
        }

        const threads = await ChatThread.find(
          { userId: req.user.walletAddress, isActive: true },
          { threadId: 1, createdAt: 1, updatedAt: 1 }
        ).sort({ updatedAt: -1 });

        res.json({ threads });
      } catch (error) {
        console.error("Error fetching threads:", error);
        res.status(500).json({
          error: "Failed to fetch chat threads",
          details: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  // Get thread history (protected)
  app.get(
    "/api/chat/history/:threadId",
    authenticateUser,
    threadHistoryValidator,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const chatThread = await ChatThread.findOne({
          threadId: req.params.threadId,
          userId: req.user?.walletAddress,
          isActive: true,
        });

        if (!chatThread) {
          return res
            .status(404)
            .json({ error: "Thread not found or unauthorized" });
        }

        res.json({
          threadId: chatThread.threadId,
          messages: chatThread.messages,
          createdAt: chatThread.createdAt,
          updatedAt: chatThread.updatedAt,
        });
      } catch (error) {
        console.error("Error fetching history:", error);
        res.status(500).json({
          error: "Failed to fetch chat history",
          details: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  // Delete a thread (protected)
  app.delete(
    "/api/chat/thread/:threadId",
    authenticateUser,
    deleteThreadValidator,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const chatThread = await ChatThread.findOne({
          threadId: req.params.threadId,
          userId: req.user?.walletAddress,
        });

        if (!chatThread) {
          return res
            .status(404)
            .json({ error: "Thread not found or unauthorized" });
        }

        try {
          // Delete thread from OpenAI
          await client.beta.threads.del(req.params.threadId);
        } catch (error) {
          console.error("Error deleting OpenAI thread:", error);
        }

        // Mark thread as inactive in database
        chatThread.isActive = false;
        await chatThread.save();

        res.json({ message: "Thread deleted successfully" });
      } catch (error) {
        console.error("Error deleting thread:", error);
        res.status(500).json({
          error: "Failed to delete thread",
          details: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );
}
