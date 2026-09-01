import { Router } from "express";
import { healthRouter } from "./health";
import { authRouter } from "./auth";
import { categoriesRouter } from "./categories";
import { transactionsRouter } from "./transactions";

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/categories", categoriesRouter);
apiRouter.use("/transactions", transactionsRouter);

// Fase 2 (próxima): apiRouter.use("/email-accounts", emailAccountsRouter);
// Fase 3 (próxima): apiRouter.use("/whatsapp", whatsappWebhookRouter);
// Fase 4 (próxima): apiRouter.use("/budgets", budgetsRouter);
