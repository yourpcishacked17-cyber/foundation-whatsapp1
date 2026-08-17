import { Router } from 'express';
import { AccountsController } from './accounts.controller.js';
import { authenticateApiKey } from '../../middleware/auth.js';

const router = Router();

router.use(authenticateApiKey);

router.post('/', AccountsController.create);
router.get('/', AccountsController.list);
router.get('/:id', AccountsController.getById);
router.post('/:id/connect', AccountsController.connect);
router.post('/:id/reconnect', AccountsController.connect);
router.get('/:id/qr', AccountsController.getQr);
router.post('/:id/pairing-code', AccountsController.requestPairingCode);
router.post('/:id/check-connection', AccountsController.checkConnection);
router.post('/:id/disconnect', AccountsController.disconnect);

export default router;
