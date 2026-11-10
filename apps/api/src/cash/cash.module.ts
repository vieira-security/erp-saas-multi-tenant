import { Module } from "@nestjs/common";
import { CashController } from "./cash.controller.js";
import { CashService } from "./cash.service.js";

/**
 * M6: caixas por operador e filial (abrir, consultar, sangria/suprimento, fechar com esperado e diferença). Pagamentos e
 * estornos são gravados pelo módulo `orders` (confirmação/cancelamento) usando cash-lock.ts e cash-math.ts.
 */
@Module({ controllers: [CashController], providers: [CashService] })
export class CashModule {}
