const SUPABASE_URL = 'https://zayoqhdteklxmmuzprub.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpheW9xaGR0ZWtseG1tdXpwcnViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzMzEzNDYsImV4cCI6MjA5NDkwNzM0Nn0.u7DeH0GcrgbIY-AwhIF6J_dN3jXH5w4Rl0vo8JVJ6hE';

window.supabaseClient = window.supabaseClient || window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
var supabase = window.supabaseClient;