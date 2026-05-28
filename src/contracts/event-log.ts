import { EventLog } from 'ethers';
import type { Log } from 'ethers';

export function isEventLog(log: Log | EventLog): log is EventLog {
  return log instanceof EventLog;
}
