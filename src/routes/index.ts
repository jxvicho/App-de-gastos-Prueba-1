import { Router } from "express";
import { healthRouter } from "./health";
import { authRouter } from "./auth";
import { categoriesRouter } from "./categories";
import { transactionsRouter } from "./transactions";
import { budgetsRouter } from "./budgets";
import { emailAccountsRouter } from "./emailAccounts";
import { banksRouter } from "./banks";

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/categories", categoriesRouter);
apiRouter.use("/transactions", transactionsRouter);
apiRouter.use("/budgets", budgetsRouter);
apiRouter.use("/email-accounts", emailAccountsRouter);
apiRouter.use("/banks", banksRouter);

// Fase 3 (próxima): apiRouter.use("/whatsapp", whatsappWebhookRouter);
