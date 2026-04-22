import { Router } from 'express';
import { bookingController } from '../controllers/booking.controller';

const router = Router();

router.get('/', bookingController.listBookings.bind(bookingController));
router.get('/packages', bookingController.getPackages.bind(bookingController));
router.get('/services', bookingController.getServices.bind(bookingController));
router.get('/available-hours/:date', bookingController.getAvailableHours.bind(bookingController));
router.post('/:id/confirm', bookingController.confirmBooking.bind(bookingController));
router.post('/:id/cancel', bookingController.cancelBooking.bind(bookingController));

export default router;
