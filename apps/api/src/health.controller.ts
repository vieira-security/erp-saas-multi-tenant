import { Controller, Get } from "@nestjs/common";
import { Public } from "./auth/http/auth-decorators.js";

/** Liveness. Público por decisão explícita: não expõe dado algum e não consulta o banco. */
@Controller("health")
export class HealthController {
  @Public()
  @Get()
  check(): { status: "ok" } {
    return { status: "ok" };
  }
}
