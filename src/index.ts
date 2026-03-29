import { createServer } from "http";
import dotenv from "dotenv";
import app from "./app";
import prisma from "./lib/prisma";
import { initSocket } from "./lib/socket";
import { SorobanEventListener } from "./services/sorobanEventListener";
import { multiSigSubmissionService } from "./services/multiSigSubmissionService";
import { validateEnv } from "./utils/envValidator";
import { hourlyAverageService } from "./services/hourlyAverageService";

// Load environment variables
dotenv.config();

// [OPS] Implement "Environment Variable" Check on Start
validateEnv();

// Validate required environment variables
const requiredEnvVars = ["STELLAR_SECRET", "DATABASE_URL"] as const;
const missingEnvVars: string[] = [];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    missingEnvVars.push(envVar);
  }
}

if (missingEnvVars.length > 0) {
  console.error("❌ Missing required environment variables:");
  missingEnvVars.forEach((varName) => console.error(`   - ${varName}`));
  console.error(
    "\nPlease set these variables in your .env file and restart the server.",
  );
  process.exit(1);
}

const dashboardUrl =
  process.env.DASHBOARD_URL ||
  process.env.FRONTEND_URL ||
  "http://localhost:3000";

if (!dashboardUrl) {
  console.error("❌ Missing required environment variable: DASHBOARD_URL");
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

// Start server
const httpServer = createServer(app);
initSocket(httpServer);
let sorobanEventListener: SorobanEventListener | null = null;
let isShuttingDown = false;

const closeHttpServer = (): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!httpServer.listening) {
      resolve();
      return;
    }

    httpServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

const shutdown = async (signal: string): Promise<void> => {
  if (isShuttingDown) {
    console.log(
      `Shutdown already in progress. Received duplicate ${signal} signal.`,
    );
    return;
  }

  isShuttingDown = true;
  console.log(`${signal} received. Starting graceful shutdown...`);

  try {
    sorobanEventListener?.stop();
    multiSigSubmissionService.stop();
    hourlyAverageService.stop();

    await closeHttpServer();
    console.log("HTTP server closed.");

    await prisma.$disconnect();
    console.log("Database connections closed cleanly.");

    process.exit(0);
  } catch (error) {
    console.error("Graceful shutdown failed:", error);
    process.exit(1);
  }
};

process.once("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    console.error("Unhandled SIGINT shutdown error:", error);
    process.exit(1);
  });
});

process.once("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    console.error("Unhandled SIGTERM shutdown error:", error);
    process.exit(1);
  });
});

httpServer.listen(PORT, () => {
  console.log(`🌊 StellarFlow Backend running on port ${PORT}`);
  console.log(
    `📊 Market Rates API available at http://localhost:${PORT}/api/market-rates`,
  );
  console.log(
    `📚 API Documentation available at http://localhost:${PORT}/api/docs`,
  );
  console.log(`🏥 Health check at http://localhost:${PORT}/health`);
  console.log(`🔌 Socket.io ready for dashboard connections`);

  // Start Soroban event listener to track confirmed on-chain prices
  try {
    sorobanEventListener = new SorobanEventListener();
    sorobanEventListener.start().catch((err) => {
      console.error("Failed to start event listener:", err);
    });
    console.log(`👂 Soroban event listener started`);
  } catch (err) {
    console.warn(
      "Event listener not started:",
      err instanceof Error ? err.message : err,
    );
    sorobanEventListener = null;
  }

  // Start multi-sig submission service if enabled
  if (process.env.MULTI_SIG_ENABLED === "true") {
    try {
      multiSigSubmissionService.start().catch((err: Error) => {
        console.error("Failed to start multi-sig submission service:", err);
      });
      console.log(`🔐 Multi-Sig submission service started`);
    } catch (err) {
      console.warn(
        "Multi-sig submission service not started:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Start background hourly average job
  try {
    hourlyAverageService.start().catch((err: Error) => {
      console.error("Failed to start hourly average service:", err);
    });
    console.log(`📊 Hourly average service started`);
  } catch (err) {
    console.warn(
      "Hourly average service not started:",
      err instanceof Error ? err.message : err,
    );
  }
});

export default app;
