import { AuthService } from '../auth/auth.service';

/** Dueño de lo que se sube; vacío = sin filtro (admin). */
export interface PushOwner {
  ownerUid?: string;
}

/**
 * A quién pertenece lo que se va a subir.
 *
 * El backend solo acepta el turno de quien lo abrió (y sus ventas y movimientos);
 * a un admin le acepta cualquiera. En un equipo compartido por varios cajeros, la
 * cola local mezcla el trabajo de todos: si el cajero B sincroniza el turno del
 * cajero A, el servidor responde 403 y el POS se lo muestra a B como un registro
 * "rechazado" que B no puede resolver — pasó en producción.
 *
 * Cada quien sube lo suyo; lo de A sube cuando A entra. El admin sube todo, que es
 * justo lo que se necesita para desatorar un equipo cuyo cajero ya no vuelve.
 */
export function pushOwnerFilter(auth: AuthService): PushOwner {
  if (auth.isAdmin()) {
    return {};
  }
  // Sin sesión no hay nada que subir: un `ownerUid` vacío no filtraría nada y
  // volvería a intentar la cola entera.
  return { ownerUid: auth.user()?.uid ?? '__sin-sesion__' };
}
