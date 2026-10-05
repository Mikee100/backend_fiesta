import dayjs, { type ConfigType } from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

export const BUSINESS_TIMEZONE = 'Africa/Nairobi';

export const nowInBusinessTimezone = () => dayjs().tz(BUSINESS_TIMEZONE);

export const inBusinessTimezone = (value: ConfigType) => dayjs(value).tz(BUSINESS_TIMEZONE);

export const businessDay = (date: ConfigType) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
	? dayjs.tz(date, BUSINESS_TIMEZONE)
	: dayjs(date).tz(BUSINESS_TIMEZONE);

export function bookingDateFacts(date: string) {
	if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error('Use a valid date in YYYY-MM-DD format.');
	}
	const localDate = businessDay(date);
	if (!localDate.isValid() || localDate.format('YYYY-MM-DD') !== date) {
		throw new Error('Use a valid date in YYYY-MM-DD format.');
	}
	return {
		date,
		weekday: localDate.format('dddd'),
		isMonday: localDate.day() === 1,
		isPast: localDate.isBefore(nowInBusinessTimezone(), 'day'),
	};
}

/** Customer-facing date, e.g. "Friday, 9 October". */
export function formatCustomerDate(date: string): string {
	return businessDay(date).format('dddd, D MMMM');
}

export function nextWeekRange() {
	const now = nowInBusinessTimezone().startOf('day');
	const monday = now.subtract((now.day() + 6) % 7, 'day').add(7, 'day');
	return { fromDate: monday.format('YYYY-MM-DD'), toDate: monday.add(6, 'day').format('YYYY-MM-DD') };
}
