import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { Observable } from "rxjs";
import { AuthContextService } from "../context/auth-context.js";
import { authOfRequest, type RequestWithAuth } from "./auth-decorators.js";

/**
 * Executa o handler (e tudo o que ele aguardar) dentro de `AuthContextService.run()` com o AuthContext que o AuthGuard
 * produziu, abrindo também o TenantContext. A inscrição no Observable do handler acontece DENTRO do `run()`, então o
 * AsyncLocalStorage acompanha todo o processamento e não existe fora dele: nada vaza para outro request.
 * Rotas `@Public()` não ganham contexto algum.
 */
@Injectable()
export class AuthContextInterceptor implements NestInterceptor {
  constructor(@Inject(AuthContextService) private readonly authContext: AuthContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const auth = authOfRequest(context.switchToHttp().getRequest<RequestWithAuth>());
    if (!auth) return next.handle();
    return new Observable((subscriber) => this.authContext.run(auth, () => next.handle().subscribe(subscriber)));
  }
}
