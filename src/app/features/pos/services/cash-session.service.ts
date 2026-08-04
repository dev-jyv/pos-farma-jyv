import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, map, tap } from 'rxjs';

import { toDate, unwrapEntity, unwrapList } from '../../../core/api/api.utils';
import {
  CashMethodTotals,
  CashMovement,
  CashMovementTotals,
  CashMovementType,
  CashSession,
  CashSessionCut,
  CashSessionSummary,
} from '../../../shared/models';
import { environment } from '../../../../environments/environment';

interface CashSessionDto {
  id: string;
  openedBy: string;
  openingAmount: number;
  expectedCashAmount: number | null;
  countedCashAmount: number | null;
  cashDifference: number | null;
  summary?: CashSessionSummary | null;
  openedAt: unknown;
  closedAt: unknown;
}

interface CashSessionCutDto {
  session: CashSessionDto;
  summary: CashSessionSummary;
  expectedCashAmount?: number;
}

interface CashMovementDto {
  id: string;
  cashSessionId: string;
  type: CashMovementType;
  amount: number;
  reason: string;
  createdBy: string;
  createdAt: unknown;
}

const emptyMethod = (): CashMethodTotals => ({ count: 0, total: 0 });
const emptyMovement = (): CashMovementTotals => ({ count: 0, total: 0 });

function emptySummary(): CashSessionSummary {
  return {
    salesCount: 0,
    voidedCount: 0,
    byMethod: {
      cash: emptyMethod(),
      card: emptyMethod(),
      transfer: emptyMethod(),
      mixed: emptyMethod(),
    },
    movements: {
      deposits: emptyMovement(),
      withdrawals: emptyMovement(),
      expenses: emptyMovement(),
    },
    grandTotal: 0,
    cashInDrawer: 0,
  };
}

function mapCashSession(dto: CashSessionDto): CashSession {
  return {
    id: dto.id,
    openedBy: dto.openedBy,
    openingAmount: dto.openingAmount,
    expectedCashAmount: dto.expectedCashAmount,
    countedCashAmount: dto.countedCashAmount,
    cashDifference: dto.cashDifference,
    summary: dto.summary ?? null,
    openedAt: toDate(dto.openedAt),
    closedAt: dto.closedAt ? toDate(dto.closedAt) : null,
  };
}

function mapCut(dto: CashSessionCutDto): CashSessionCut {
  return {
    session: mapCashSession(dto.session),
    summary: {
      ...emptySummary(),
      ...dto.summary,
      movements: dto.summary?.movements ?? emptySummary().movements,
    },
    expectedCashAmount: dto.expectedCashAmount,
  };
}

function mapMovement(dto: CashMovementDto): CashMovement {
  return {
    id: dto.id,
    cashSessionId: dto.cashSessionId,
    type: dto.type,
    amount: dto.amount,
    reason: dto.reason,
    createdBy: dto.createdBy,
    createdAt: toDate(dto.createdAt),
  };
}

@Injectable({ providedIn: 'root' })
export class CashSessionService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;

  readonly current = signal<CashSession | null>(null);
  readonly isOpen = signal(false);

  fetchCurrent(): Observable<CashSession | null> {
    return this.http.get<unknown>(`${this.apiUrl}/cash-sessions/current`).pipe(
      map((response) => {
        const entity = unwrapEntity<CashSessionDto | null>(response);
        return entity ? mapCashSession(entity) : null;
      }),
      tap((session) => this.setCurrent(session)),
    );
  }

  open(openingAmount: number): Observable<CashSession> {
    return this.http
      .post<unknown>(`${this.apiUrl}/cash-sessions`, { openingAmount })
      .pipe(
        map((response) => mapCashSession(unwrapEntity<CashSessionDto>(response))),
        tap((session) => this.setCurrent(session)),
      );
  }

  getSummary(sessionId: string): Observable<CashSessionCut> {
    return this.http
      .get<unknown>(`${this.apiUrl}/cash-sessions/${sessionId}/summary`)
      .pipe(map((response) => mapCut(unwrapEntity<CashSessionCutDto>(response))));
  }

  close(sessionId: string, countedCashAmount: number): Observable<CashSessionCut> {
    return this.http
      .post<unknown>(`${this.apiUrl}/cash-sessions/${sessionId}/close`, { countedCashAmount })
      .pipe(
        map((response) => mapCut(unwrapEntity<CashSessionCutDto>(response))),
        tap(() => this.setCurrent(null)),
      );
  }

  listMovements(sessionId: string): Observable<CashMovement[]> {
    return this.http
      .get<unknown>(`${this.apiUrl}/cash-sessions/${sessionId}/movements`)
      .pipe(map((response) => unwrapList<CashMovementDto>(response).map(mapMovement)));
  }

  addMovement(
    sessionId: string,
    input: { type: CashMovementType; amount: number; reason: string },
  ): Observable<CashMovement> {
    return this.http
      .post<unknown>(`${this.apiUrl}/cash-sessions/${sessionId}/movements`, input)
      .pipe(map((response) => mapMovement(unwrapEntity<CashMovementDto>(response))));
  }

  private setCurrent(session: CashSession | null): void {
    this.current.set(session);
    this.isOpen.set(session !== null && session.closedAt === null);
  }
}
