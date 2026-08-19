'use strict';
const { Markup } = require('telegraf');

// Memori sementara untuk menyimpan nama user yang sedang menunggu ACC
const pendingApprovals = new Map(); 

module.exports = function(bot, pool) {

    // ================= 1. FUNGSI PICUAN OTOMATIS DARI /START =================
    bot.handleNewUserRegistration = async (ctx) => {
        const userId = ctx.from.id.toString();
        const nama = ctx.from.first_name || 'Pengguna';
        const username = ctx.from.username ? `@${ctx.from.username}` : 'Tidak ada username';
        const adminId = process.env.ADMIN_CHAT_ID;

        if (!adminId) return ctx.reply('⚠️ Sistem Master Admin belum dikonfigurasi di .env');

        // Simpan nama ke memori sementara (Map)
        pendingApprovals.set(userId, nama);

        // Beri tahu petugas baru untuk menunggu
        await ctx.reply('⏳ Selamat datang! Akun Anda belum terdaftar di sistem.\nPermintaan akses otomatis telah dikirim ke Master Admin. Mohon tunggu persetujuan.');

        // Susun notifikasi + Tombol Role untuk dikirim ke Master Admin
        const adminMsg = `🔔 <b>PERMINTAAN AKSES BARU</b>\n\nNama: <b>${nama}</b>\nUsername: ${username}\nID Telegram: <code>${userId}</code>\n\nSilakan tentukan kedudukan pengguna ini:`;
        
        const roleButtons = Markup.inlineKeyboard([
            [Markup.button.callback('👑 Jadikan Sub Admin', `role_admin_${userId}`)],
            [Markup.button.callback('👷 Jadikan Petugas Visit', `role_teknisi_${userId}`)],
            [Markup.button.callback('❌ Tolak Akses', `tolak_${userId}`)]
        ]);

        try {
            // Kirim pesan langsung ke Master Admin
            await bot.telegram.sendMessage(adminId, adminMsg, { parse_mode: 'HTML', ...roleButtons });
        } catch (err) {
            console.error('Gagal mengirim ke Master Admin:', err);
        }
    };

    // ================= 2. ADMIN KLIK ROLE -> MASUK DATABASE =================
    bot.action(/^role_(admin|teknisi)_(\d+)$/, async (ctx) => {
        const adminId = process.env.ADMIN_CHAT_ID;
        // Keamanan: Pastikan hanya Master Admin yang bisa menekan tombol ini
        if (ctx.from.id.toString() !== adminId) return ctx.answerCbQuery('⛔ Hanya Master Admin yang bisa melakukan ini!', { show_alert: true });

        const role = ctx.match[1]; // Menangkap kata 'admin' atau 'teknisi'
        const userId = ctx.match[2];
        
        // Ambil nama dari memori sementara, jika bot terestart, gunakan fallback
        const nama = pendingApprovals.get(userId) || 'Petugas Baru';

        try {
            // Cek apakah user ternyata sudah ada di DB agar tidak error duplikat
            const cekDb = await pool.query('SELECT status_aktif FROM petugas WHERE telegram_id = $1', [userId]);
            if (cekDb.rows.length === 0) {
                // EKSEKUSI INSERT KE DATABASE AIVEN
                await pool.query(
                    'INSERT INTO petugas (telegram_id, nama_petugas, role, status_aktif) VALUES ($1, $2, $3, true)',
                    [userId, nama, role]
                );
            } else {
                // Jika sudah ada tapi tidak aktif, update saja statusnya
                await pool.query(
                    'UPDATE petugas SET role = $1, status_aktif = true WHERE telegram_id = $2',
                    [role, userId]
                );
            }

            pendingApprovals.delete(userId); // Bersihkan memori

            await ctx.answerCbQuery();
            await ctx.editMessageText(`🎉 <b>${nama}</b> berhasil ditambahkan ke database sebagai <b>${role.toUpperCase()}</b>.`, { parse_mode: 'HTML' });

            // Beritahu Karyawan bahwa mereka sudah di-ACC
            const roleText = role === 'admin' ? 'Sub Admin (Akses Penuh)' : 'Petugas Visit (Akses Lapangan)';
            await bot.telegram.sendMessage(userId, `🎉 Selamat! Akses Anda disetujui.\n\nKedudukan Anda: <b>${roleText}</b>\n\nKetik /start untuk membuka menu operasional.`, { parse_mode: 'HTML' });

        } catch (err) {
            console.error('Insert DB Error:', err);
            await ctx.answerCbQuery('❌ Gagal menyimpan data ke Aiven PostgreSQL!', { show_alert: true });
        }
    });

    // ================= 3. ADMIN KLIK "TOLAK" =================
    bot.action(/^tolak_(\d+)$/, async (ctx) => {
        const adminId = process.env.ADMIN_CHAT_ID;
        if (ctx.from.id.toString() !== adminId) return ctx.answerCbQuery('⛔ Ditolak!', { show_alert: true });

        const userId = ctx.match[1];
        pendingApprovals.delete(userId); 

        await ctx.answerCbQuery();
        await ctx.editMessageText('❌ Permintaan akses dibatalkan/ditolak.');
        
        try {
            await bot.telegram.sendMessage(userId, '❌ Maaf, permintaan akses Anda ditolak oleh Master Admin.');
        } catch (e) {} 
    });
};