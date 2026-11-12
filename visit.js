const sharp = require('sharp');
const { Markup } = require('telegraf');
const { isRegisteredPetugas } = require('./daftar_petugas');

// ============================================================================
// visit.js -- Fitur LAPOR VISIT (dipakai karyawan_visit, admin, master_admin)
//
// UX: cukup ketik /visit (atau tekan tombol 📋 Lapor Visit), lalu ikuti
// pertanyaan bot tahap demi tahap -- TIDAK PERLU menulis ulang command.
//
// Alur 9 tahap:
//   1. ID Pelanggan          5. Keterangan       8. Titik koordinat (location)
//   2. Nama Contact Person   6. Hasil visit      9. Foto bukti (auto-compress WebP)
//   3. Nomor Contact Person  7. Nama petugas
//   4. Nama Telkom Daerah
//
// Setelah selesai: upsert data CP ke tabel `pelanggan`, insert record ke
// tabel `laporan_visit`, upload foto ke storage bucket `foto_visit`.
// Ketik /cancel kapan saja untuk membatalkan proses.
// ============================================================================

// Label tombol menu utama (pengaman: tekan tombol menu di tengah proses
// tidak akan ditelan sebagai jawaban tahap visit).
const MENU_LABELS = ['📋 Lapor Visit', '📊 Laporan Visit', '📝 Riwayat Visit', '👥 Daftar Petugas', '⚙️ Atur Role', 'ℹ️ Bantuan', '📝 Daftar Akun'];

const DAFTAR_TELDA = [
    'Binjai', 'Kabanjahe', 'Kisaran', 'Lubuk Pakam', 'Inner-Sumut',
    'Padang Sidempuan', 'Rantau Prapat', 'Siantar', 'Sibolga', 'Toba'
];

const HASIL_VISIT = [
    ['Janji Bayar', 'LUNAS'],
    ['Alamat tidak ditemukan', 'Usaha sudah tutup / pindah'],
    ['PIC tidak ada di lokasi', 'Lokasi terlalu jauh'],
    ['Sudah cabut', 'Permintaan cabut'],
    ['Komplain / CASE yang perlu di follow up'],
    ['Lainnya (Ketik Manual)']
];

function keyboardTelda() {
    return Markup.keyboard(
        DAFTAR_TELDA.reduce((rows, c, i) => {
            if (i % 2 === 0) rows.push([c]); else rows[rows.length - 1].push(c);
            return rows;
        }, [])
    ).oneTime().resize();
}

function keyboardHasil() {
    return Markup.keyboard(HASIL_VISIT).oneTime().resize();
}

module.exports = (bot, supabase) => {

    // Handler dipakai bersama oleh command /visit dan tombol 📋 Lapor Visit
    async function handlerVisit(ctx) {
        if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
            return ctx.reply('Command /visit hanya dapat digunakan lewat chat pribadi (japri ke bot).');
        }
        if (!(await isRegisteredPetugas(supabase, ctx.from.id))) {
            return ctx.reply('Anda belum terdaftar sebagai petugas. Tekan tombol 📝 Daftar Akun untuk mengajukan akses.');
        }

        ctx.session.step = 'visit_1_id_pelanggan';
        ctx.session.data = {};
        ctx.reply('Mari mulai laporan visit.\n\nTahap 1/9: Silakan masukkan ID Pelanggan:', { parse_mode: 'Markdown', ...Markup.removeKeyboard() });
    }
    bot.command('visit', handlerVisit);
    bot.hears('📋 Lapor Visit', handlerVisit);

    // ==========================================
    // Tombol inline: pakai Nama CP / Nomor CP dari database
    // ==========================================
    bot.action('USE_NAMA_CP', async (ctx) => {
        if (ctx.session?.step !== 'visit_2_nama_cp') return ctx.answerCbQuery('Tombol ini sudah kadaluarsa.');
        await ctx.answerCbQuery();
        await ctx.editMessageReplyMarkup(undefined).catch(() => {});

        const namaCp = ctx.session.data.db_nama_cp;
        await ctx.reply(`Menggunakan Nama CP dari database: ${namaCp}`);

        ctx.session.data.nama_cp = namaCp;
        lanjutKeNomorCp(ctx);
    });

    bot.action('USE_NOMOR_CP', async (ctx) => {
        if (ctx.session?.step !== 'visit_3_nomor_cp') return ctx.answerCbQuery('Tombol ini sudah kadaluarsa.');
        await ctx.answerCbQuery();
        await ctx.editMessageReplyMarkup(undefined).catch(() => {});

        const nomorCp = ctx.session.data.db_nomor_cp;
        await ctx.reply(`Menggunakan Nomor CP dari database: ${nomorCp}`);

        ctx.session.data.nomor_cp = nomorCp;
        lanjutKeTelda(ctx);
    });

    function lanjutKeNomorCp(ctx) {
        ctx.session.step = 'visit_3_nomor_cp';
        const dbNomor = ctx.session.data.db_nomor_cp;
        if (dbNomor) {
            const btn = Markup.inlineKeyboard([
                [Markup.button.callback(`Gunakan: ${dbNomor}`, 'USE_NOMOR_CP')]
            ]);
            ctx.reply(
                `Tahap 3/9: Nomor telepon ditemukan (${dbNomor})!\n\nKlik tombol untuk memakai nomor ini, atau ketik nomor alternatif baru:`,
                btn
            );
        } else {
            ctx.reply('Tahap 3/9: Masukkan Nomor Contact Person (contoh: 08123456789):', Markup.removeKeyboard());
        }
    }

    function lanjutKeTelda(ctx) {
        ctx.session.step = 'visit_4_nama_telkom';
        ctx.reply('Tahap 4/9: Silakan pilih Nama Telkom Daerah:', keyboardTelda());
    }

    // ==========================================
    // Tangkap input user selama alur visit berjalan
    // ==========================================
    bot.on('message', async (ctx, next) => {
        if (!ctx.session) return next();

        const step = ctx.session.step || '';
        if (!step.startsWith('visit_')) return next();

        const text = ctx.message.text;
        if (text && text.startsWith('/')) return next();
        if (text && MENU_LABELS.includes(text.trim())) return next(); // pindah fitur lewat tombol menu
        if (!text && !ctx.message.photo && !ctx.message.location) return next();

        switch (step) {

            case 'visit_1_id_pelanggan': {
                ctx.session.data.id_pelanggan = text.trim();

                const loading = await ctx.reply('Memeriksa data pelanggan di sistem...');
                try {
                    const { data } = await supabase
                        .from('pelanggan')
                        .select('nama_cp, nomor_cp')
                        .eq('id_pelanggan', ctx.session.data.id_pelanggan)
                        .maybeSingle();

                    await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id);

                    ctx.session.step = 'visit_2_nama_cp';
                    if (data) {
                        ctx.session.data.db_nama_cp = data.nama_cp;
                        ctx.session.data.db_nomor_cp = data.nomor_cp;
                    }

                    if (data?.nama_cp) {
                        const btn = Markup.inlineKeyboard([
                            [Markup.button.callback(`Gunakan: ${data.nama_cp}`, 'USE_NAMA_CP')]
                        ]);
                        ctx.reply('Tahap 2/9: Data ditemukan! Klik tombol untuk memakai Nama CP yang ada, atau ketik nama baru:', btn);
                    } else {
                        ctx.reply(`Tahap 2/9: Masukkan Nama Contact Person untuk ID ${ctx.session.data.id_pelanggan}:`, Markup.removeKeyboard());
                    }
                } catch (err) {
                    console.error('Gagal mengecek pelanggan:', err);
                    await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
                    ctx.session.step = 'visit_2_nama_cp';
                    ctx.reply(`Tahap 2/9: Masukkan Nama Contact Person untuk ID ${ctx.session.data.id_pelanggan}:`, Markup.removeKeyboard());
                }
                break;
            }

            case 'visit_2_nama_cp': {
                ctx.session.data.nama_cp = text.trim();
                lanjutKeNomorCp(ctx);
                break;
            }

            case 'visit_3_nomor_cp': {
                const nomorLama = ctx.session.data.db_nomor_cp;
                const nomorBaru = text.trim();
                // Gabungkan nomor lama & baru supaya histori kontak tidak hilang
                if (nomorLama && String(nomorLama).trim() !== '' && nomorLama !== '-' && nomorLama !== nomorBaru) {
                    ctx.session.data.nomor_cp = `${nomorLama} / ${nomorBaru}`;
                } else {
                    ctx.session.data.nomor_cp = nomorBaru;
                }
                lanjutKeTelda(ctx);
                break;
            }

            case 'visit_4_nama_telkom': {
                if (!DAFTAR_TELDA.includes(text.trim())) {
                    return ctx.reply('Silakan pilih Nama Telkom Daerah dari tombol di bawah.', keyboardTelda());
                }
                ctx.session.data.nama_telkom = text.trim();
                ctx.session.step = 'visit_5_keterangan';
                ctx.reply('Tahap 5/9: Masukkan Keterangan Visit (contoh: Pengecekan rumah kosong):', Markup.removeKeyboard());
                break;
            }

            case 'visit_5_keterangan': {
                ctx.session.data.keterangan = text.trim();
                ctx.session.step = 'visit_6_hasil';
                ctx.reply('Tahap 6/9: Pilih atau ketik Hasil Visit:', keyboardHasil());
                break;
            }

            case 'visit_6_hasil':
            case 'visit_6_hasil_manual': {
                if (step === 'visit_6_hasil' && text.trim() === 'Lainnya (Ketik Manual)') {
                    ctx.session.step = 'visit_6_hasil_manual';
                    ctx.reply('Silakan ketik manual Hasil Visit:', Markup.removeKeyboard());
                    break;
                }
                ctx.session.data.hasil = text.trim();
                ctx.session.step = 'visit_7_petugas';

                await ctx.reply('Memuat daftar petugas dari database...', Markup.removeKeyboard());
                try {
                    const { data: daftarPetugas, error } = await supabase
                        .from('petugas_access')
                        .select('nama')
                        .eq('status', 'approved');

                    if (error) throw error;

                    let buttons = [];
                    if (daftarPetugas && daftarPetugas.length > 0) {
                        for (let i = 0; i < daftarPetugas.length; i += 2) {
                            const row = [`${daftarPetugas[i].nama}`];
                            if (daftarPetugas[i + 1]) row.push(daftarPetugas[i + 1].nama);
                            buttons.push(row);
                        }
                    }
                    buttons.push(['Lainnya (Ketik Manual)']);

                    ctx.reply('Tahap 7/9: Siapa Petugas yang melakukan visit ini?', Markup.keyboard(buttons).oneTime().resize());
                } catch (err) {
                    console.error('Gagal mengambil data petugas:', err);
                    ctx.reply('Tahap 7/9: Siapa Petugas yang melakukan visit ini? (Ketik manual nama petugas):');
                }
                break;
            }

            case 'visit_7_petugas':
            case 'visit_7_petugas_manual': {
                if (step === 'visit_7_petugas' && text.trim() === 'Lainnya (Ketik Manual)') {
                    ctx.session.step = 'visit_7_petugas_manual';
                    ctx.reply('Silakan ketik manual Nama Petugas:', Markup.removeKeyboard());
                    break;
                }
                ctx.session.data.petugas = text.trim();
                ctx.session.step = 'visit_8_koordinat';
                ctx.reply('Tahap 8/9: Silakan kirim Titik Koordinat (Share Location) dari fitur attachment Telegram:', Markup.removeKeyboard());
                break;
            }

            case 'visit_8_koordinat': {
                if (ctx.message.location) {
                    ctx.session.data.lat = ctx.message.location.latitude;
                    ctx.session.data.lon = ctx.message.location.longitude;
                    ctx.session.step = 'visit_9_gambar';
                    ctx.reply('Tahap 9/9 (terakhir): Silakan kirim Gambar / Foto Bukti Visit.');
                } else {
                    ctx.reply('Harap gunakan fitur attachment -> Location untuk mengirim titik koordinat, bukan mengetik teks.');
                }
                break;
            }

            case 'visit_9_gambar': {
                if (!ctx.message.photo) {
                    return ctx.reply('Harap kirimkan foto sebagai bukti.');
                }

                ctx.reply('Mendownload gambar, mengompres ke WebP, dan menyimpan ke database...');

                try {
                    const sesi = ctx.session.data;
                    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                    const fileLink = await ctx.telegram.getFileLink(fileId);

                    const response = await fetch(fileLink.href);
                    const imageBuffer = Buffer.from(await response.arrayBuffer());

                    const webpBuffer = await sharp(imageBuffer)
                        .webp({ quality: 80 })
                        .toBuffer();

                    const fileName = `visit_${sesi.id_pelanggan}_${Date.now()}.webp`;

                    const { error: storageError } = await supabase
                        .storage.from('foto_visit')
                        .upload(fileName, webpBuffer, { contentType: 'image/webp', upsert: false });
                    if (storageError) throw new Error(`Upload storage gagal: ${storageError.message}`);

                    const { data: urlData } = supabase.storage.from('foto_visit').getPublicUrl(fileName);
                    const fotoUrl = urlData.publicUrl;

                    const { error: errPelanggan } = await supabase
                        .from('pelanggan')
                        .upsert([{
                            id_pelanggan: sesi.id_pelanggan,
                            nama_cp: sesi.nama_cp,
                            nomor_cp: sesi.nomor_cp
                        }], { onConflict: 'id_pelanggan' });
                    if (errPelanggan) throw new Error(`Upsert pelanggan gagal: ${errPelanggan.message}`);

                    const { error: errVisit } = await supabase
                        .from('laporan_visit')
                        .insert([{
                            id_pelanggan: sesi.id_pelanggan,
                            nama_telkom_daerah: sesi.nama_telkom,
                            nomor_cp: sesi.nomor_cp,
                            keterangan: sesi.keterangan,
                            hasil_visit: sesi.hasil,
                            nama_petugas: sesi.petugas,
                            koordinat: `POINT(${sesi.lon} ${sesi.lat})`,
                            foto_url: fotoUrl
                        }]);
                    if (errVisit) throw new Error(`Insert laporan visit gagal: ${errVisit.message}`);

                    const rekap = `
REKAP DATA TERSIMPAN
ID Pelanggan: ${sesi.id_pelanggan}
Nama CP: ${sesi.nama_cp}
Nomor CP: ${sesi.nomor_cp}
Telkom Daerah: ${sesi.nama_telkom}
Keterangan: ${sesi.keterangan}
Hasil: ${sesi.hasil}
Petugas: ${sesi.petugas}
Koordinat: https://maps.google.com/?q=${sesi.lat},${sesi.lon}
Foto: ${fotoUrl}`;

                    await ctx.reply(rekap, { disable_web_page_preview: true });
                    // await ctx.reply(rekap);
                    await ctx.reply('Laporan visit berhasil disimpan. Terima kasih!');

                    ctx.session.step = 'idle';
                    ctx.session.data = {};
                } catch (error) {
                    console.error('Error simpan laporan visit:', error);
                    ctx.reply(`Terjadi kesalahan: ${error.message}`);
                    ctx.session.step = 'idle';
                    ctx.session.data = {};
                }
                break;
            }

            default:
                return next();
        }
    });
};