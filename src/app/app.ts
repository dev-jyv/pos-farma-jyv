import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastModule } from 'primeng/toast';

import { SyncScheduler } from './core/sync/sync-scheduler.service';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, ToastModule],
  template: `
    <router-outlet />
    <p-toast position="top-right" />
  `,
})
export class App {
  private readonly syncScheduler = inject(SyncScheduler);

  constructor() {
    this.syncScheduler.start();
  }
}
