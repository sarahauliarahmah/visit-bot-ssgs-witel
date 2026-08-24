// index.js
'use strict';

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');

// ================= DATABASE (AIVEN) =================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[index.js] Unexpected PG pool error:', err);
});

// ================= SISTEM MANAJEMEN MEMORI (SESSION & GARBAGE COLLECTOR) =================
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const sessionStore = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // Batas waktu sesi 30 Menit (dalam milidetik)

bot.use((ctx, next) => {
    const key = ctx.from && ctx.chat ? `${ctx.from.id}:${ctx.chat.id}` : null;
    if (!key) return next();

    let session = sessionStore.get(key);
    const now = Date.now();

    if (session && (now - session.lastActivity > SESSION_TTL_MS)) {
        session = null; 
        if (ctx.callbackQuery || ctx.message) {
            ctx.reply('⏳ Sesi pengisian laporan Anda telah berakhir otomatis karena tidak ada aktivitas selama 30 menit. Silakan mulai ulang.');
        }
    }

    if (!session) {
        session = { step: 'idle', data: {}, lastActivity: now };
    } else {
        session.lastActivity = now; 
    }

    ctx.session = session;
    sessionStore.set(key, session);

    return next();
});

// GARBAGE COLLECTOR
setInterval(() => {
    const now = Date.now();
    let deletedCount = 0;
    for (const [key, session] of sessionStore.entries()) {
        if (now - session.lastActivity > SESSION_TTL_MS) {
            sessionStore.delete(key);
            deletedCount++;
        }
    }
    if (deletedCount > 0) {
        console.log(`🧹 [Garbage Collector] Berhasil menghapus ${deletedCount} sesi menggantung. Sisa memori aktif: ${sessionStore.size}`);
    }
}, 60 * 60 * 1000);

// ================= SISTEM KEAMANAN & RBAC =================
const petugasCache = new Map();
const PETUGAS_CACHE_TTL_MS = 5 * 60 * 1000; 

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

bot.use(async (ctx, next) => {
    const userId = ctx.from?.id?.toString();
    const text = ctx.message?.text || '';
    const masterAdminId = process.env.ADMIN_CHAT_ID; 

    if (text.startsWith('/start') || text === '/cancel') {
        return next();
    }

    if (userId === masterAdminId) {
        ctx.state.role = 'master_admin'; 
        return next();
    }

    const role = await getPetugasRole(userId);
    if (role) {
        ctx.state.role = role; 
        return next();
    }

    if (ctx.callbackQuery) {
        return ctx.answerCbQuery('⛔ Anda belum terdaftar. Silakan ketik /start untuk meminta akses.', { show_alert: true });
    } else {
        console.log(`⛔ Akses ditolak untuk user ${userId}`);
        return; 
    }
});

// ================= COMMAND: /start =================
bot.start(async (ctx) => {
    const userId = ctx.from.id.toString();
    const nama = ctx.from.first_name || 'Petugas';
    const masterAdminId = process.env.ADMIN_CHAT_ID;

    let isRegistered = false;
    if (userId === masterAdminId) {
        isRegistered = true;
    } else {
        const role = await getPetugasRole(userId);
        if (role) isRegistered = true;
    }

    if (!isRegistered) {
        if (typeof bot.handleNewUserRegistration === 'function') {
            return bot.handleNewUserRegistration(ctx);
        }
        return ctx.reply('⚠️ Modul pendaftaran belum dimuat.');
    }

    // UX DIPERBAIKI: Penambahan tombol Bantuan
    const menuMarkup = Markup.inlineKeyboard([
        [Markup.button.callback('🚀 Mulai Visit', 'btn_visit'), Markup.button.callback('📜 Riwayat Visit', 'btn_riwayat')],
        [Markup.button.callback('📊 Rekap Laporan', 'btn_laporan'), Markup.button.callback('💡 Bantuan', 'btn_help')]
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
            reply_markup: { remove_keyboard: true } 
        });
    } else {
        ctx.reply('ℹ️ Tidak ada proses aktif yang sedang berjalan.', {
            reply_markup: { remove_keyboard: true } 
        });
    }
});

// ================= MODUL =================
require('./visit')(bot, pool); 
require('./daftar_petugas')(bot, pool);
const reportManager = require('./report_manager')(bot, pool); // Mesin Pelaporan Baru

// ----- AREA KHUSUS ADMIN -----
function isAdmin(ctx) {
    return ctx.state.role === 'admin' || ctx.state.role === 'master_admin';
}


// ================= HANDLING KLIK TOMBOL & COMMAND =================

// 1. FITUR VISIT UMUM
bot.action('btn_visit', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 1;
    ctx.session.data = {};
    return ctx.reply('🚀 Memulai laporan visit.\n\nTahap 1: Silakan masukkan *ID Pelanggan*:', { 
        parse_mode: 'Markdown',
        reply_markup: { remove_keyboard: true }
    });
});

// 2. FITUR RIWAYAT
bot.command('riwayat', async (ctx) => {
    const textArgs = ctx.message.text.replace('/riwayat', '').trim();
    if (textArgs.length > 5) {
        return reportManager.tarikRiwayatId(ctx, textArgs);
    }
    ctx.session.step = 'menunggu_id_riwayat_visit';
    ctx.reply('🔍 Silakan ketik *ID Pelanggan / No. Internet*:', { parse_mode: 'Markdown' });
});

bot.action('btn_riwayat', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'menunggu_id_riwayat_visit';
    return ctx.reply('🔍 Masukkan *ID Pelanggan / No. Internet* untuk melihat histori visitnya:', { 
        parse_mode: 'Markdown',
        reply_markup: { remove_keyboard: true } 
    });
});


bot.on('message', async (ctx, next) => {
    if (ctx.session && ctx.session.step === 'menunggu_id_riwayat_visit') {
        const text = ctx.message.text || '';
        const cleanId = text.replace(/[^0-9]/g, '');
        if (cleanId.length < 8) return ctx.reply('⚠️ ID harus berupa angka valid (minimal 8 digit).');
        return reportManager.tarikRiwayatId(ctx, cleanId);
    }
    return next();
});

// 3. FITUR REKAP & EXCEL (DIKUNCI UNTUK ADMIN)
bot.action('btn_laporan', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔ Hanya Admin yang bisa mengakses Laporan!', { show_alert: true });
    await ctx.answerCbQuery();
    return reportManager.tarikDataRekap(ctx, '', true); 
});

bot.command('rekap', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('⛔ Hanya Admin yang bisa mengakses command ini.');
    const textArgs = ctx.message.text.replace('/rekap', '').trim();
    return reportManager.tarikDataRekap(ctx, textArgs, false); 
});

bot.action(/^cetak_html_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔ Akses ditolak!', { show_alert: true });
    await ctx.answerCbQuery('⏳ Mempersiapkan gambar tabel...');
    const params = ctx.match[1].split('_');
    return reportManager.cetakTabelGambar(ctx, params[0], params[1]);
});

bot.action(/^cetak_excel_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔ Akses ditolak!', { show_alert: true });
    await ctx.answerCbQuery('⏳ Mempersiapkan file Excel...');
    const params = ctx.match[1].split('_');
    return reportManager.cetakExcel(ctx, params[0], params[1]);
});

//4. FITUR BANTUAN

bot.action('btn_help', async (ctx) => {
    // Menghilangkan ikon loading pada tombol yang ditekan
    await ctx.answerCbQuery(); 
    
    const pesanHelp = `
💡 *PANDUAN PENGGUNAAN VISIT BOT* 💡

Bot ini dirancang khusus untuk pelaporan dan penagihan pelanggan Indibiz SSGS Witel Sumut.

*A. Alur Pelaporan Teknisi*
1. Tekan tombol *🚀 Mulai Visit*.
2. Jawab pertanyaan bot secara berurutan.
3. Pastikan Anda berada di lokasi saat mengirim Titik Koordinat (Share Location).
4. Lampirkan Foto Bukti fisik sebagai langkah terakhir.

*B. Daftar Perintah Cepat*
/start - Membuka menu utama
/riwayat - Mencari histori visit berdasarkan ID Pelanggan (Contoh: /riwayat 12345678)
/rekap [Tanggal] - [Admin] Menarik data (Contoh: /rekap hari ini)
/cancel - Membatalkan sesi input yang macet / menggantung

*C. Kendala Sistem*
Jika bot terasa lambat atau salah merespons, ketik /cancel untuk mereset memori bot, lalu ketik /start kembali. 
Jika Anda ditolak oleh sistem, silakan lapor ke Master Admin.
    `;
    
    return ctx.reply(pesanHelp, { parse_mode: 'Markdown' });
});

// ================= MENYALAKAN BOT =================
console.log('🤖 Mesin Telegraf Bot Telkom sedang melakukan booting...');
bot.launch();
console.log('✅ Mesin Telegraf Bot Telkom berhasil menyala dengan Aiven PostgreSQL!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));