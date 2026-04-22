import cron from 'node-cron';
import { automationService } from './automation.service';

export class CronService {
  /**
   * Initialize all cron jobs
   */
  init() {
    console.log('Initializing Automation Cron Jobs...');

    // Run every hour at the top of the hour
    cron.schedule('0 * * * *', async () => {
      console.log('[CRON] Running hourly automation checks...');
      
      try {
        await automationService.processReminders();
        await automationService.processFollowups();
      } catch (error) {
        console.error('[CRON] Error in hourly automation checks:', error);
      }
    });

    console.log('Cron Jobs Scheduled: Hourly check for Reminders and Follow-ups.');
  }
}

export const cronService = new CronService();
