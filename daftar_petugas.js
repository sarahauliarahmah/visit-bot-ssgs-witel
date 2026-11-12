const { Markup } = require('telegraf');

// ============================================================================
// daftar_petugas.js -- Pusat kendali AKSES & ROLE pengguna bot.
//
// Role yang dipakai di kolom `role` tabel `petugas_access`:
//   - karyawan_visit : hanya boleh lapor visit
//   - admin          : lapor visit + rekap/laporan visit + riwayat visit
//   - master_admin   : semua fitur + kelola pendaftaran & role pengguna
//
// Bootstrap master_admin PERTAMA (belum ada satupun di database):
//   insert manual ke Supabase:
//     insert into petugas_access
//       (user_id, nama, username, role, status, requested_at, decided_at)
//     values
//       ('<id_telegram>', 'Nama', null, 'master_admin', 'approved', now(), now());
//
// Tidak ada command bot yang bisa menaikkan seseorang jadi master_admin tanpa
// otorisasi -- itu sengaja, supaya tidak ada jalur self-promote.
//
// UX BARU (berbasis tombol):
//   📝 Daftar Akun  -> sama dengan /daftar
//   👥 Daftar Petugas -> sama dengan /daftar_petugas
//   ⚙️ Atur Role -> alur bertahap: ketik user_id -> pilih role lewat tombol
//      (command manual /atur_role <id> <role> tetap didukung sebagai jalan pintas)
// ============================================================================

const ROLE = {
    KARYAWAN: 'karyawan_visit',
    ADMIN: 'admin',
    MASTER: 'master_admin'
};

const ROLE_LABEL = {
    karyawan_visit: 'Karyawan Visit',
    admin: 'Admin',
    master_admin: 'Master Admin'
};

// Label tombol menu utama (dipakai sebagai pengaman: kalau user menekan tombol
// menu di tengah proses input bertahap, inputnya tidak ditelan sebagai data).
const MENU_LABELS = ['📋 Lapor Visit', '📊 Laporan Visit', '📝 Riwayat Visit', '👥 Daftar Petugas', '⚙️ Atur Role', 'ℹ️ Bantuan', '📝 Daftar Akun'];

// Cache singkat supaya tidak query DB di tiap pesan (middleware akses dipanggil
// di hampir semua update). TTL pendek supaya pencabutan akses cepat berlaku.
const roleCache = new Map();
const CACHE_TTL_MS = 2 * 60 * 1000;

async function getRoleCached(supabase, userId) {
    const key = String(userId);
    const cached = roleCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.role;

    const { data, error } = await supabase
        .from('petugas_access')
        .select('role')
        .eq('user_id', key)
        .eq('status', 'approved')
        .maybeSingle();

    const role = (!error && data?.role) ? data.role : null;
    roleCache.set(key, { role, expiresAt: Date.now() + CACHE_TTL_MS });
    return role;
}

function invalidateCache(userId) {
    roleCache.delete(String(userId));
}

// Dipakai di visit.js (semua petugas yang approved boleh lapor visit)
async function isRegisteredPetugas(supabase, userId) {
    const role = await getRoleCached(supabase, userId);
    return role !== null;
}

// Dipakai di report_manager.js (admin & master_admin boleh laporan/riwayat)
async function isAdmin(supabase, userId) {
    const role = await getRoleCached(supabase, userId);
    return role === ROLE.ADMIN || role === ROLE.MASTER;
}

// Dipakai di command kelola-akses (hanya master_admin)
async function isMasterAdmin(supabase, userId) {
    const role = await getRoleCached(supabase, userId);
    return role === ROLE.MASTER;
}

async function getDaftarMasterAdmin(supabase) {
    const { data, error } = await supabase
        .from('petugas_access')
        .select('user_id, nama')
        .eq('role', ROLE.MASTER)
        .eq('status', 'approved');
    if (error) {
        console.error('Gagal mengambil daftar master admin:', error);
        return [];
    }
    return data || [];
}

module.exports = (bot, supabase) => {

    // ================================================================
    // /daftar & tombol 📝 Daftar Akun -- USER: ajukan pendaftaran
    // ================================================================
    async function handlerDaftar(ctx) {
        const userId = String(ctx.from.id);
        const nama = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
        const username = ctx.from.username || null;

        const role = await getRoleCached(supabase, userId);
        if (role) {
            return ctx.reply(`Anda sudah terdaftar sebagai ${ROLE_LABEL[role]}. Tidak perlu mendaftar lagi.`);
        }

        const masterAdmins = await getDaftarMasterAdmin(supabase);
        if (masterAdmins.length === 0) {
            console.warn('Belum ada master_admin (role=master_admin, status=approved) di database.');
            return ctx.reply('Pendaftaran belum bisa diproses (belum ada Master Admin terdaftar). Hubungi pengelola database.');
        }

        const { data: existing, error: cekError } = await supabase
            .from('petugas_access')
            .select('status')
            .eq('user_id', userId)
            .maybeSingle();

        if (cekError) {
            console.error('Gagal cek status pendaftaran:', cekError);
            return ctx.reply('Terjadi kesalahan, silakan coba lagi.');
        }
        if (existing?.status === 'pending') {
            return ctx.reply('Permintaan pendaftaran Anda masih menunggu persetujuan Master Admin.');
        }

        // Insert baru, atau ajukan ulang kalau sebelumnya pernah ditolak
        const { error: simpanError } = await supabase
            .from('petugas_access')
            .upsert({
                user_id: userId,
                nama,
                username,
                role: ROLE.KARYAWAN, // default paling rendah -- role naik HANYA lewat ⚙️ Atur Role oleh master_admin
                status: 'pending',
                requested_at: new Date().toISOString(),
                decided_at: null,
                decided_by: null
            });

        if (simpanError) {
            console.error('Gagal menyimpan permintaan pendaftaran:', simpanError);
            return ctx.reply('Gagal mengirim permintaan pendaftaran, silakan coba lagi.');
        }

        await ctx.reply('Permintaan pendaftaran Anda telah dikirim ke Master Admin. Anda akan diberi tahu di sini setelah diproses.');

        const teks = `PERMINTAAN PENDAFTARAN BARU

Nama: ${nama}
ID: ${userId}
Username: ${username ? '@' + username : '-'}`;
        const keyboard = Markup.inlineKeyboard([
            Markup.button.callback('✅ Setujui', `approve_petugas_${userId}`),
            Markup.button.callback('❌ Tolak', `reject_petugas_${userId}`)
        ]);

        for (const ma of masterAdmins) {
            try {
                await bot.telegram.sendMessage(ma.user_id, teks, keyboard);
            } catch (err) {
                console.error(`Gagal kirim notifikasi pendaftaran ke ${ma.user_id}:`, err.message);
            }
        }
    }
    bot.command('daftar', handlerDaftar);
    bot.hears('📝 Daftar Akun', handlerDaftar);

    // ================================================================
    // MASTER ADMIN: setujui pendaftaran
    // WHERE status='pending' = penjamin anti-double-processing.
    // ================================================================
    bot.action(/^approve_petugas_(\d+)$/, async (ctx) => {
        if (!(await isMasterAdmin(supabase, ctx.from.id))) {
            return ctx.answerCbQuery('Anda tidak berwenang melakukan ini.', { show_alert: true });
        }
        const targetId = ctx.match[1];

        const { data, error } = await supabase
            .from('petugas_access')
            .update({ status: 'approved', decided_at: new Date().toISOString(), decided_by: String(ctx.from.id) })
            .eq('user_id', targetId)
            .eq('status', 'pending')
            .select();

        if (error) {
            console.error('Gagal menyetujui petugas:', error);
            return ctx.answerCbQuery('Terjadi kesalahan.', { show_alert: true });
        }
        if (!data || data.length === 0) {
            await ctx.answerCbQuery('Permintaan ini sudah diproses sebelumnya.', { show_alert: true });
            return ctx.editMessageReplyMarkup(undefined).catch(() => {});
        }

        invalidateCache(targetId);
        await ctx.answerCbQuery('Disetujui');
        await ctx.editMessageText(
            `${ctx.callbackQuery.message.text}\n\n[Disetujui oleh ${ctx.from.first_name}]`
        ).catch(() => {});

        try {
            await bot.telegram.sendMessage(targetId, 'Pendaftaran Anda telah DISETUJUI. Ketik /start untuk melihat menu fitur bot.');
        } catch (err) {
            console.error(`Gagal memberi tahu user ${targetId}:`, err.message);
        }
    });

    // ================================================================
    // MASTER ADMIN: tolak pendaftaran
    // ================================================================
    bot.action(/^reject_petugas_(\d+)$/, async (ctx) => {
        if (!(await isMasterAdmin(supabase, ctx.from.id))) {
            return ctx.answerCbQuery('Anda tidak berwenang melakukan ini.', { show_alert: true });
        }
        const targetId = ctx.match[1];

        const { data, error } = await supabase
            .from('petugas_access')
            .update({ status: 'rejected', decided_at: new Date().toISOString(), decided_by: String(ctx.from.id) })
            .eq('user_id', targetId)
            .eq('status', 'pending')
            .select();

        if (error) {
            console.error('Gagal menolak petugas:', error);
            return ctx.answerCbQuery('Terjadi kesalahan.', { show_alert: true });
        }
        if (!data || data.length === 0) {
            await ctx.answerCbQuery('Permintaan ini sudah diproses sebelumnya.', { show_alert: true });
            return ctx.editMessageReplyMarkup(undefined).catch(() => {});
        }

        invalidateCache(targetId);
        await ctx.answerCbQuery('Ditolak');
        await ctx.editMessageText(
            `${ctx.callbackQuery.message.text}\n\n[Ditolak oleh ${ctx.from.first_name}]`
        ).catch(() => {});

        try {
            await bot.telegram.sendMessage(targetId, 'Maaf, permintaan pendaftaran Anda DITOLAK oleh Master Admin.');
        } catch (err) {
            console.error(`Gagal memberi tahu user ${targetId}:`, err.message);
        }
    });

    // ================================================================
    // /daftar_petugas & tombol 👥 Daftar Petugas -- MASTER ADMIN: lihat semua
    // ================================================================
    async function handlerDaftarPetugas(ctx) {
        if (!(await isMasterAdmin(supabase, ctx.from.id))) {
            return ctx.reply('Command ini khusus Master Admin.');
        }
        if (ctx.chat.type !== 'private') {
            return ctx.reply('Fitur ini hanya bisa dipakai lewat chat pribadi dengan bot.');
        }

        const { data: list, error } = await supabase
            .from('petugas_access')
            .select('user_id, nama, username, role, status, requested_at')
            .order('requested_at', { ascending: true });

        if (error) {
            console.error('Gagal ambil daftar petugas:', error);
            return ctx.reply('Gagal mengambil data petugas.');
        }
        if (!list || list.length === 0) {
            return ctx.reply('Belum ada siapa pun di database petugas_access.');
        }

        const labelStatus = { approved: 'AKTIF', pending: 'MENUNGGU', rejected: 'DITOLAK' };

        let teks = `DAFTAR PENGGUNA BOT (${list.length} orang)\n\n`;
        list.forEach((p, i) => {
            const role = ROLE_LABEL[p.role] || p.role || ROLE_LABEL[ROLE.KARYAWAN];
            teks += `${i + 1}. ${p.nama} -- ${role} -- ${labelStatus[p.status] || p.status}\n`;
            teks += `   ID: ${p.user_id} | @${p.username || '-'}\n\n`;
        });

        // Telegram membatasi ~4096 karakter per pesan -- pecah kalau perlu
        const BATAS = 3500;
        while (teks.length > 0) {
            const potong = teks.length > BATAS ? teks.lastIndexOf('\n\n', BATAS) + 2 : teks.length;
            await ctx.reply(teks.slice(0, potong));
            teks = teks.slice(potong);
        }
    }
    bot.command('daftar_petugas', handlerDaftarPetugas);
    bot.hears('👥 Daftar Petugas', handlerDaftarPetugas);

    // ================================================================
    // ⚙️ Atur Role -- alur bertahap berbasis tombol:
    //   1) bot minta user_id (ketik saja, tanpa command)
    //   2) bot tampilkan tombol pilihan role
    //   3) role langsung diubah + notifikasi ke petugas
    // Jalan pintas manual tetap didukung: /atur_role <user_id> <role>
    // (role master_admin SENGAJA tidak tersedia -- hanya via database)
    // ================================================================
    async function prosesAturRole(ctx, targetId, roleBaru) {
        const { data: target, error } = await supabase
            .from('petugas_access')
            .update({ role: roleBaru })
            .eq('user_id', targetId)
            .eq('status', 'approved')
            .select();

        if (error) {
            console.error('Gagal update role:', error);
            return ctx.reply('Terjadi kesalahan saat menyimpan.');
        }
        if (!target || target.length === 0) {
            return ctx.reply(`Tidak ditemukan petugas ber-ID ${targetId} dengan status approved. Cek kembali lewat 👥 Daftar Petugas.`);
        }

        invalidateCache(targetId);
        await ctx.reply(`${target[0].nama} sekarang ber-role ${ROLE_LABEL[roleBaru]} (${targetId}).`);

        try {
            await bot.telegram.sendMessage(targetId, `Role Anda diubah menjadi ${ROLE_LABEL[roleBaru]} oleh Master Admin. Ketik /start untuk melihat menu Anda.`);
        } catch (err) {
            console.error(`Gagal memberi tahu ${targetId}:`, err.message);
        }
    }

    async function mulaiAturRole(ctx) {
        if (!(await isMasterAdmin(supabase, ctx.from.id))) {
            return ctx.reply('Command ini khusus Master Admin.');
        }
        if (ctx.chat.type !== 'private') {
            return ctx.reply('Fitur ini hanya bisa dipakai lewat chat pribadi dengan bot.');
        }

        // Jalan pintas: /atur_role <user_id> <role>
        const text = ctx.message.text;
        if (text.startsWith('/atur_role')) {
            const parts = text.trim().split(/\s+/);
            if (parts.length >= 3) {
                const roleInput = parts[2].toLowerCase();
                if (!Object.values(ROLE).includes(roleInput)) {
                    return ctx.reply('Role tidak dikenali. Pilihan: karyawan_visit, admin (master_admin hanya via database).');
                }
                if (roleInput === ROLE.MASTER) {
                    return ctx.reply('Role master_admin HANYA bisa diatur manual lewat database (langkah keamanan).');
                }
                return prosesAturRole(ctx, parts[1], roleInput);
            }
        }

        ctx.session.step = 'aturrole_tunggu_id';
        ctx.session.data = {};
        return ctx.reply(
            'Ubah Role Petugas\n\nKetik user_id (ID Telegram) petugas yang mau diubah role-nya.\nLihat daftar ID lewat tombol 👥 Daftar Petugas.\nKetik /cancel untuk batal.',
            Markup.removeKeyboard()
        );
    }
    bot.command('atur_role', mulaiAturRole);
    bot.hears('⚙️ Atur Role', mulaiAturRole);

    // Tangkap user_id yang diketik master admin
    bot.on('text', async (ctx, next) => {
        if (ctx.session?.step !== 'aturrole_tunggu_id') return next();

        const text = ctx.message.text;
        if (text.startsWith('/')) return next();
        if (MENU_LABELS.includes(text.trim())) return next(); // pindah fitur lewat tombol menu

        ctx.session.data = { targetId: text.trim() };
        ctx.session.step = 'aturrole_pilih_role';
        return ctx.reply(
            `Pilih role baru untuk user_id ${text.trim()}:`,
            Markup.inlineKeyboard([
                [Markup.button.callback('Karyawan Visit', 'aturrole_karyawan_visit')],
                [Markup.button.callback('Admin', 'aturrole_admin')]
            ])
        );
    });

    // Tangkap pilihan role lewat tombol
    bot.action(/^aturrole_(karyawan_visit|admin)$/, async (ctx) => {
        if (!(await isMasterAdmin(supabase, ctx.from.id))) {
            return ctx.answerCbQuery('Anda tidak berwenang melakukan ini.', { show_alert: true });
        }
        const targetId = ctx.session?.data?.targetId;
        if (!targetId) {
            await ctx.answerCbQuery();
            return ctx.reply('Sesi sudah berakhir. Ulangi lewat tombol ⚙️ Atur Role.');
        }
        await ctx.answerCbQuery();
        await ctx.editMessageReplyMarkup(undefined).catch(() => {});
        ctx.session.step = 'idle';
        ctx.session.data = {};
        return prosesAturRole(ctx, targetId, ctx.match[1]);
    });
};

// Diekspor untuk dipakai middleware akses global (index.js), visit.js, report_manager.js
module.exports.ROLE = ROLE;
module.exports.ROLE_LABEL = ROLE_LABEL;
module.exports.isMasterAdmin = isMasterAdmin;
module.exports.isAdmin = isAdmin;
module.exports.isRegisteredPetugas = isRegisteredPetugas;
module.exports.invalidateCache = invalidateCache;
module.exports.getRoleCached = getRoleCached;