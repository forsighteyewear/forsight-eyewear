/**
 * Contact Lens Trial — Automated Follow-up & Expiry Messages.
 *
 * A daily cron checks every active contact-lens trial stored in the CMS data
 * (Supabase) and sends the "Follow Up" message 7 days after the appointment
 * date and the "Trial Expiry" message 28 days after the appointment date.
 *
 * Manual triggering is available via POST /api/contact-lens-trials/process.
 */

import cron from 'node-cron';
import fetch from 'node-fetch';

const TRIAL_FOLLOWUP_DELAY_DAYS = 7;
const TRIAL_EXPIRY_DELAY_DAYS = 28;

const DEFAULT_TRIAL_TEMPLATES = {
  before:
    "FORSIGHT EYEWEAR – CONTACT LENS APPOINTMENT\n\nHello {firstName},\n\nThis is a reminder of your upcoming contact lens fitting and training appointment.\n\nDate: {appointmentDate}\nTime: {appointmentTime}\nWith: one of our contact lens fitters\nLocation: {storeName}\n\nIMPORTANT – PLEASE READ BEFORE YOUR APPOINTMENT\n\nYOUR FINGERNAILS MUST BE SHORT AND TRIMMED BEFORE YOUR APPOINTMENT.\n\nIF YOUR NAILS ARE TOO LONG, WE WILL NOT BE ABLE TO COMPLETE YOUR CONTACT LENS TRAINING, AND YOUR APPOINTMENT WILL NEED TO BE RESCHEDULED.\n\nPlease also note:\n\n• Arrive on time for your scheduled appointment.\n• Allow 15–60 minutes for your contact lens training.\n• You will learn how to safely insert and remove your contact lenses.\n• If you are unable to complete the training during your appointment, an additional appointment may be required.\n\nACKNOWLEDGEMENT REQUIRED\n\nPlease reply YES to this message to confirm that you have received and read these important instructions.\n\nWe look forward to seeing you!\n\nForsight Eyewear",
  after:
    "FORSIGHT EYEWEAR – CONTACT LENS CARE & INSTRUCTIONS\n\nHello {firstName},\n\nThank you for visiting Forsight Eyewear today for your contact lens fitting and training appointment!\n\nWe hope you're enjoying your new contact lenses.\n\nIMPORTANT – CARING FOR YOUR CONTACT LENSES\n\nYour eye health and comfort are our priorities. Please remember the instructions provided during your appointment.\n\n1. INSERTING & REMOVING YOUR LENSES\n\nAlways wash and thoroughly dry your hands before handling your lenses.\n\nFollow the insertion and removal techniques demonstrated during your appointment.\n\nNever force a lens into or out of your eye.\n\nIf you're having difficulty, contact our clinic for assistance.\n\n2. WEARING YOUR TRIAL LENSES\n\nFollow the wearing schedule provided by your eye-care professional.\n\nNever sleep in your contact lenses unless specifically instructed by your eye-care professional.\n\nNever use tap water or saliva to clean or store contact lenses.\n\nFollow the specific replacement and care instructions for your prescribed lens type.\n\n3. COMFORT & VISION\n\nAs you become accustomed to your new lenses, please pay attention to:\n\nOverall comfort\n\nClarity of vision\n\nDryness or irritation\n\nAny difficulties inserting or removing your lenses\n\nIMPORTANT: If you experience eye pain, significant redness, unusual light sensitivity or changes in vision, remove your lenses immediately and seek prompt professional eye care.\n\n4. YOUR TRIAL PERIOD\n\nYour contact lens trial allows you to evaluate comfort and vision before purchasing your lenses.\n\nPLEASE NOTE: You have 45 days from your fitting appointment to place your contact lens order. After this period, another fitting assessment will be required.\n\n5. WE'LL CHECK IN WITH YOU\n\nWe'll send you a short follow-up message in approximately 7 days to see how you're doing.\n\nIf you experience any difficulties before then, please contact us at {storePhone}.\n\nPLEASE REPLY YES to acknowledge that you have received these instructions.\n\nThank you for choosing Forsight Eyewear!\n\nWe're here to help you see clearly and comfortably. — {storeName}",
