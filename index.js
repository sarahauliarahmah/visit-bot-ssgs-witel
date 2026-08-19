'use strict';

require('dotenv').config();
const { Telegraf, session, Markup } = require('telegraf');
const { Pool } = require('pg');

// ================= DATABASE (AIVEN) =================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[index.js] Unexpected PG pool error:', err);
});

// ================= INISIALISASI TELEGRAF =================
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

bot.use(session());
bot.use((ctx, next) => {
    ctx.session = ctx.session || { step: 'idle', data: {} };
    return next();
});

// ================= SISTEM KEAMANAN & RBAC =================
const petugasCache = new Map();
const PETUGAS_CACHE_TTL_MS = 5 * 60 * 1000; // Cache 5 menit

// Fungsi cek role di database
async function getPetugasRole(userId) {
    const cached = petugasCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.role;

    try {
        const res = await pool.query('SELECT role, status_aktif FROM petugas WHERE telegram_id = $1', [userId]);
        if (res.rows.length > 0 && res.rows[0].status_aktif === true) {
            const userRole = res.rows[0].role;
            petugasCache.set(userId, { role: userRole, expiresAt: Date.now() + PETUGAS_CACHE_TTL_MS });
            return userRole;
        }
        return null;
    } catch (err) {
        console.error('DB Error checking petugas:', err);
        return null;
    }
}

// MIDDLEWARE (Satpam): Mencegat semua pesan & klik tombol
bot.use(async (ctx, next) => {
    const userId = ctx.from?.id?.toString();
    const text = ctx.message?.text || '';
    const masterAdminId = process.env.ADMIN_CHAT_ID; // Wajib ada di .env

    // 1. Selalu izinkan akses ke pintu pendaftaran dan pembatalan
    if (text.startsWith('/start') || text === '/cancel') {
        return next();
    }

    // 2. Berikan akses tanpa batas untuk Master Admin
    if (userId === masterAdminId) {
        ctx.state.role = 'master_admin'; 
        return next();
    }

    // 3. Cek database untuk Karyawan (Sub Admin / Teknisi Visit)
    const role = await getPetugasRole(userId);
    if (role) {
        ctx.state.role = role; // Simpan jabatannya di memory Telegraf
        return next();
    }

    // 4. JIKA TIDAK PUNYA AKSES:
    if (ctx.callbackQuery) {
        // Jika pencet tombol
        return ctx.answerCbQuery('⛔ Anda belum terdaftar. Ketik /daftar [Nama Anda]', { show_alert: true });
    } else {
        // Jika kirim pesan biasa, diamkan saja agar bot tidak spam
        console.log(`⛔ Akses ditolak untuk user ${userId}`);
        return; 
    }
});

// ================= COMMAND: /start =================
bot.start(async (ctx) => {
    const userId = ctx.from.id.toString();
    const nama = ctx.from.first_name || 'Petugas';
    const masterAdminId = process.env.ADMIN_CHAT_ID;

    // 1. Cek Kedudukan User di Database
    let isRegistered = false;
    if (userId === masterAdminId) {
        isRegistered = true;
    } else {
        const role = await getPetugasRole(userId);
        if (role) isRegistered = true;
    }

    // 2. Jika BELUM TERDAFTAR -> Panggil fungsi kirim notif ke Admin
    if (!isRegistered) {
        // Fungsi ini ada di dalam file daftar_petugas.js
        if (typeof bot.handleNewUserRegistration === 'function') {
            return bot.handleNewUserRegistration(ctx);
        }
        return ctx.reply('⚠️ Modul pendaftaran belum dimuat.');
    }

    // 3. Jika SUDAH TERDAFTAR / MASTER ADMIN -> Tampilkan Menu Utama
    const menuMarkup = Markup.inlineKeyboard([
        [Markup.button.callback('🚀 Mulai Visit', 'btn_visit'), Markup.button.callback('📜 Riwayat Visit', 'btn_riwayat')],
        [Markup.button.callback('📊 Rekap Laporan', 'btn_laporan'), Markup.button.callback('📥 Export Excel', 'btn_excel')],
        [Markup.button.callback('👥 Kelola Petugas', 'btn_petugas')]
    ]);

    ctx.reply(
        `👋 Halo <b>${nama}</b>!\nSelamat datang di Bot Penagihan & Laporan Indibiz Witel Sumut.\n\nSilakan pilih menu operasional di bawah ini:`,
        {
            parse_mode: 'HTML',
            ...menuMarkup
        }
    );
});

bot.command('cancel', (ctx) => {
    if (ctx.session.step !== 'idle') {
        ctx.session.step = 'idle';
        ctx.session.data = {};
        ctx.reply('❌ Proses input yang sedang berjalan telah dibatalkan.', {
            reply_markup: { remove_keyboard: true } // <-- Perintah pembersih
        });
    } else {
        ctx.reply('ℹ️ Tidak ada proses aktif yang sedang berjalan.', {
            reply_markup: { remove_keyboard: true } // <-- Perintah pembersih
        });
    }
});

// ================= MODUL / COMMAND LAINNYA =================
require('./visit')(bot, pool);
require('./daftar_petugas')(bot, pool);
require('./riwayat_visit')(bot, pool);
const laporanVisitModul = require('./laporan_visit')(bot, pool);
const excelModul = require('./excel_export')(bot, pool);

// ================= HANDLING KLIK TOMBOL INLINE =================
bot.action('btn_visit', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 1;
    ctx.session.data = {};
    return ctx.reply('🚀 Memulai laporan visit.\n\nTahap 1: Silakan masukkan *ID Pelanggan*:', { 
        parse_mode: 'Markdown',
        reply_markup: { remove_keyboard: true } // <-- Perintah pembersih ditambahkan di sini
    });
});

bot.action('btn_riwayat', async (ctx) => {
    await ctx.answerCbQuery();
    // Langsung ubah sesi ke mode pencarian riwayat
    ctx.session.step = 'menunggu_id_riwayat_visit';
    return ctx.reply('🔍 Masukkan *ID Pelanggan / No. Internet* untuk melihat histori visitnya:', { 
        parse_mode: 'Markdown',
        reply_markup: { remove_keyboard: true } // Menghapus keyboard sisa jika ada
    });
});

// ----- AREA KHUSUS ADMIN -----
function isAdmin(ctx) {
    return ctx.state.role === 'admin' || ctx.state.role === 'master_admin';
}

bot.action('btn_laporan', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔ Hanya Admin yang bisa mengakses Laporan!', { show_alert: true });
    
    await ctx.answerCbQuery();
    
    // Parameter ketiga dikirim bernilai "true", 
    // menyuruh sistem menampilkan KESELURUHAN DATA
    return laporanVisitModul.prosesLaporan(ctx, '', true); 
});

bot.action('btn_excel', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔ Hanya Admin yang bisa Export Excel!', { show_alert: true });

    await ctx.answerCbQuery();

    // Memanggil fungsi ekspor dokumen Excel
    return excelModul.prosesExportExcel(ctx, []);
});

bot.action('btn_petugas', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔ Hanya Admin yang bisa mengelola Petugas!', { show_alert: true });

    await ctx.answerCbQuery();
    return ctx.reply('👥 Fitur manajemen daftar petugas diaktifkan.');
});

// ================= MENYALAKAN BOT =================
console.log('🤖 Mesin Telegraf Bot Telkom sedang melakukan booting...');
bot.launch();
console.log('✅ Mesin Telegraf Bot Telkom berhasil menyala dengan Aiven PostgreSQL!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));