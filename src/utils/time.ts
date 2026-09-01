import dayjs, { type ConfigType } from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

export const BUSINESS_TIMEZONE = 'Africa/Nairobi';

export const nowInBusinessTimezone = () => dayjs().tz(BUSINESS_TIMEZONE);

export const inBusinessTimezone = (value: ConfigType) => dayjs(value).tz(BUSINESS_TIMEZONE);

export const businessDay = (date: ConfigType) => dayjs(date).tz(BUSINESS_TIMEZONE);
