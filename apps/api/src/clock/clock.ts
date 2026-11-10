import { Global, Module } from "@nestjs/common";

/**
 * Relógio da aplicação. Regras que dependem de "agora" (dia de operação do pedido, timestamps de estado) leem a hora
 * daqui, nunca de `new Date()` direto: os testes injetam um relógio controlado para cobrir a virada do dia no fuso da
 * filial sem `sleep` e sem mexer no relógio do sistema.
 */
export const CLOCK = Symbol("CLOCK");

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = Object.freeze({ now: () => new Date() });

@Global()
@Module({ providers: [{ provide: CLOCK, useValue: systemClock }], exports: [CLOCK] })
export class ClockModule {}
