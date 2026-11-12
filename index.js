require('dotenv').config();
const { Telegraf, session, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
// const bot = new Telegraf(process.env.BOT_TOKEN);

const https = require('https');

const agent = new https.Agent({ keepAlive: false, family: 4 });
const bot = new Telegraf(process.env.BOT_TOKEN, {
    telegram: { agent }
});

bot.use(session());

bot.catch((err, ctx) => {
    console.error(`Error pada update ${ctx.update?.update_id}:`, err.message);
    // Jangan di-throw ulang supaya proses tidak mati
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err?.message || err);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err?.message || err);
});

// Default session supaya tidak error saat dibaca modul lain
bot.use((ctx, next) => {
    ctx.session = ctx.session || { step: 'idle', data: {} };
    return next();
});

// ============================================================================
// LOGGING AKSES KE TERMINAL -- Master Admin memantau SIAPA SAJA yang
// mengakses bot lewat output terminal/console tempat bot berjalan.
// ============================================================================
bot.use((ctx, next) => {
    const identitas = ctx.from?.username
        ? `@${ctx.from.username}`
        : (ctx.from?.first_name || `ID:${ctx.from?.id ?? '-'}`);
    const waktu = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const jenis = ctx.chat?.type === 'private' ? 'private' : `grup ${ctx.chat?.id}`;
    const isi = ctx.message?.text
        || (ctx.message?.photo ? '[foto]' : '')
        || (ctx.message?.location ? '[lokasi]' : '')
        || (ctx.callbackQuery?.data ? `[tombol: ${ctx.callbackQuery.data}]` : '')
        || '[media lain]';
    console.log(`(${waktu}) Dipakai oleh ${identitas} (${ctx.from?.id}) via ${jenis} -> ${isi}`);
    return next();
});

// ============================================================================
// PEMBATASAN AKSES -- Bot hanya untuk karyawan yang dikenali.
// Command publik hanya untuk pendaftaran & bantuan dasar; fitur lain lewat
// tombol menu (yang tetap melewati pengecekan role di handler masing-masing).
// ============================================================================
const { isRegisteredPetugas, isAdmin, isMasterAdmin } = require('./daftar_petugas');

// Teks tombol publik + command publik. Command fitur (/visit, /laporan_visit,
// dst) SENGAJA tidak dipublikasikan di menu Telegram, tapi tetap bisa diketik
// manual oleh yang berhak.
const PUBLIC_TEXTS = ['/daftar', '/start', '/help', '/cancel', '📝 Daftar Akun', 'ℹ️ Bantuan'];

bot.use(async (ctx, next) => {
    const userId = ctx.from?.id?.toString();
    if (!userId) return next();

    // Callback query dibiarkan lewat -- handler tombol masing-masing yang
    // cek role-nya (supaya penolakan berjalan benar).
    if (ctx.callbackQuery) return next();

    const text = ctx.message?.text || '';
    const isPublic = PUBLIC_TEXTS.some(t =>
        text === t || (t.startsWith('/') && (text.startsWith(t + ' ') || text.startsWith(t + '@')))
    );
    if (isPublic) return next();

    if (await isRegisteredPetugas(supabase, userId)) return next();

    console.log(`Akses DITOLAK untuk user ${userId} (@${ctx.from?.username || '-'})`);
    if (text && !ctx.message?.photo && !ctx.message?.location) {
        await ctx.reply(
            'Anda belum terdaftar sebagai karyawan yang dikenali.\nTekan tombol di bawah untuk mengajukan akses.',
            Markup.keyboard([['📝 Daftar Akun'], ['ℹ️ Bantuan']]).resize()
        );
    }
});

// ============================================================================
// MENU UTAMA -- Tombol keyboard yang disesuaikan per role.
// Tombol mengirim teks yang ditangkap handler command di modul masing-masing,
// jadi klik tombol == ketik command manual.
// ============================================================================
async function kirimMenuUtama(ctx, teksAwal) {
    const userId = String(ctx.from.id);
    let tombol, teks;

    if (await isMasterAdmin(supabase, userId)) {
        tombol = [
            ['📋 Lapor Visit', '📊 Laporan Visit'],
            ['📝 Riwayat Visit', '👥 Daftar Petugas'],
            ['⚙️ Atur Role', 'ℹ️ Bantuan']
        ];
        teks = teksAwal || 'Menu Utama — Master Admin\nPilih fitur di bawah (atau ketik command-nya secara manual):';
    } else if (await isAdmin(supabase, userId)) {
        tombol = [
            ['📋 Lapor Visit', '📊 Laporan Visit'],
            ['📝 Riwayat Visit', 'ℹ️ Bantuan']
        ];
        teks = teksAwal || 'Menu Utama — Admin\nPilih fitur di bawah (atau ketik command-nya secara manual):';
    } else if (await isRegisteredPetugas(supabase, userId)) {
        tombol = [['📋 Lapor Visit'], ['ℹ️ Bantuan']];
        teks = teksAwal || 'Menu Utama — Karyawan Visit\nPilih fitur di bawah:';
    } else {
        tombol = [['📝 Daftar Akun'], ['ℹ️ Bantuan']];
        teks = teksAwal || 'Anda belum terdaftar.\nTekan tombol di bawah untuk mengajukan akses ke bot:';
    }
    return ctx.reply(teks, Markup.keyboard(tombol).resize());
}

const helpText =
`Bantuan — Sistem Laporan Visit

Menu Telegram bot ini hanya berisi 3 command: /start, /help, /cancel.
Semua fitur lain diakses lewat TOMBOL menu (atau tetap bisa diketik manual):

📋 Lapor Visit (/visit) — buat laporan visit. Bisa dipakai karyawan, admin, master admin.
📊 Laporan Visit (/laporan_visit) — rekap laporan visit. Admin pilih periode lewat tombol, lalu pilih export PNG atau Excel.
📝 Riwayat Visit (/riwayat_visit) — riwayat visit per ID pelanggan. Ketik ID-nya saja, lalu pilih periode lewat tombol.
👥 Daftar Petugas (/daftar_petugas) — lihat semua pengguna bot (master admin).
⚙️ Atur Role (/atur_role) — ubah role pengguna via tombol (master admin).
📝 Daftar Akun (/daftar) — ajukan akses untuk user baru.

Tips:
- Selama proses input bertahap, ketik /cancel untuk membatalkan.
- Format tanggal bebas: 05 11 2026 | 05/11/2026 | 05 November 2026 | rentang: 01 11 2026 05 11 2026
- Command dengan argumen tetap bisa: /riwayat_visit 111201107052 01 11 2026 05 11 2026

Role:
- Karyawan Visit : hanya lapor visit
- Admin : lapor visit + laporan & riwayat visit
- Master Admin : semua fitur + kelola pendaftaran & role`;

bot.start((ctx) => kirimMenuUtama(ctx));

async function helpHandler(ctx) {
    await ctx.reply(helpText);
    return kirimMenuUtama(ctx);
}
bot.help(helpHandler);
bot.hears('ℹ️ Bantuan', helpHandler);

bot.command('cancel', (ctx) => {
    if (ctx.session.step !== 'idle') {
        ctx.session.step = 'idle';
        ctx.session.data = {};
        ctx.reply('Proses yang sedang berjalan telah dibatalkan.');
    } else {
        ctx.reply('Tidak ada proses yang sedang berjalan.');
    }
    return kirimMenuUtama(ctx);
});

// ============================================================================
// MODUL FITUR
// ============================================================================
require('./daftar_petugas')(bot, supabase);   // pendaftaran, persetujuan, daftar petugas, atur role
require('./visit')(bot, supabase);            // lapor visit (semua role approved)
require('./report_manager')(bot, supabase);   // laporan visit (rekap + export) & riwayat visit (admin ke atas)

// ============================================================================
// MENU COMMAND TELEGRAM -- SENGAJA HANYA 3 COMMAND.
// Fitur lain diakses lewat tombol menu (lihat kirimMenuUtama).
// ============================================================================
bot.telegram.setMyCommands([
    { command: 'start', description: 'Tampilkan menu utama (tombol fitur)' },
    { command: 'help', description: 'Bantuan penggunaan bot' },
    { command: 'cancel', description: 'Batalkan proses input yang sedang berjalan' }
]).then(() => {
    console.log('Menu command Telegram berhasil disinkronkan.');
}).catch((err) => {
    console.error('Gagal mengatur menu command:', err.message);
});

// ============================================================================
// NYALAKAN BOT
// ============================================================================
bot.launch().then(() => {
    console.log('Bot Laporan Visit berhasil menyala dan siap menerima perintah!');
    console.log('Pantau baris log "Dipakai oleh ..." untuk melihat siapa yang mengakses bot.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));