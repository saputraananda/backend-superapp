import { Router } from "express";
import {
	listCutoffHolidays,
	saveCutoffHoliday,
	listHolidayYears,
	listHolidays,
	createHoliday,
	updateHoliday,
	deleteHoliday,
} from "../../controllers/Alora/holidayController.js";

const router = Router();

// Cutoff routes
router.get   ("/cutoff",  listCutoffHolidays); // GET  /alora/holidays/cutoff?year=YYYY
router.post  ("/cutoff",  saveCutoffHoliday);  // POST /alora/holidays/cutoff

// Years list
router.get   ("/years",   listHolidayYears);   // GET  /alora/holidays/years

// Calendar routes (fallback / legacy)
router.get   ("/",        listHolidays);       // GET  /alora/holidays?year=YYYY
router.post  ("/",        createHoliday);      // POST /alora/holidays
router.patch ("/:id",     updateHoliday);      // PATCH /alora/holidays/:id
router.delete("/:id",     deleteHoliday);      // DELETE /alora/holidays/:id

export default router;
