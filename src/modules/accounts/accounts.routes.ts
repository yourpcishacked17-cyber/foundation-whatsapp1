import { Router } from 'express';
import { AccountsController } from './accounts.controller.js';
import { authenticateApiKey } from '../../middleware/auth.js';

const router = Router();

router.use(authenticateApiKey);

router.post('/', AccountsController.create);
router.get('/', AccountsController.list);
router.get('/:id', AccountsController.getById);
router.post('/:id/connect', AccountsController.connect);
router.get('/:id/qr', AccountsController.getQr);
router.post('/:id/confirm', AccountsController.confirm);
router.post('/:id/disconnect', AccountsController.disconnect);

export default router;
