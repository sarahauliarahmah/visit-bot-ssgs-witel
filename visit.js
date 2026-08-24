// visit.js
'use strict';

// 1. Panggil Cloudinary (Axios dan Sharp sudah dibuang)
const cloudinary = require('cloudinary').v2;

// 2. Konfigurasi Cloudinary dari file .env
cloudinary.config({ 
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
    api_key: process.env.CLOUDINARY_API_KEY, 
    api_secret: process.env.CLOUDINARY_API_SECRET 
});

module.exports = function (bot, pool) {

// ================= 1. LISTENER PESAN TEKS & MEDIA =================
    bot.on('message', async (ctx, next) => {
        const session = ctx.session;
        const text = ctx.message.text ? ctx.message.text.trim() : '';

        if (text.startsWith('/')) return next();
        if (!session || typeof session.step !== 'number') return next();

        try {
            if (session.step === 1) {
                // VALIDASI: ID Pelanggan minimal 10 karakter (mencegah input asal seperti "1" atau "ok")
                if (text.length < 10) {
                    return ctx.reply('⚠️ Format salah! *ID Pelanggan / No. Internet* terlalu pendek (minimal 10 karakter). Silakan coba lagi:', { parse_mode: 'Markdown' });
                }
                session.data.id_pelanggan = text;
                session.step = 2;
                return ctx.reply(`Tahap 2/10: Masukkan <b>Nama Pelanggan / Instansi</b> (Contoh: PT Maju Jaya / Klinik Sehat):`, { parse_mode: 'HTML' });
            }
            else if (session.step === 2) {
                session.data.nama_pelanggan = text;
                session.step = 3;
                return ctx.reply(`Tahap 3/10: Masukkan <b>Nama Contact Person (CP)</b> yang ditemui:`, { parse_mode: 'HTML' });
            }
            else if (session.step === 3) {
                session.data.nama_cp = text;
                session.step = 4;
                return ctx.reply(`Tahap 4/10: Masukkan <b>Nomor Contact Person</b>:`, { parse_mode: 'HTML' });
            }
            else if (session.step === 4) {
                // VALIDASI & SANITASI: Ekstrak hanya angka. Jika user mengetik "0812-3456-7890", tanda strip akan dibuang.
                const cleanNoCP = text.replace(/[^0-9]/g, ''); 
                
                // Cek apakah jumlah angkanya logis untuk nomor telepon (9 hingga 15 digit)
                if (cleanNoCP.length < 9 || cleanNoCP.length > 15) {
                    return ctx.reply('⚠️ Format salah! Harap masukkan *Nomor Contact Person* berupa ANGKA yang valid (9-15 digit):', { parse_mode: 'Markdown' });
                }
                
                session.data.no_cp = cleanNoCP; // Menyimpan angka yang sudah bersih ke memori
                session.step = 5;
                return ctx.reply('Tahap 5/10: Silakan pilih Telkom Daerah (TelDa) berikut', {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Binjai', callback_data: 'telda_Binjai' }, { text: 'Kabanjahe', callback_data: 'telda_Kabanjahe' }],
                            [{ text: 'Kisaran', callback_data: 'telda_Kisaran' }, { text: 'Lubuk Pakam', callback_data: 'telda_Lubuk Pakam' }],
                            [{ text: 'Inner-Sumut', callback_data: 'telda_Inner-Sumut' }, { text: 'Padang Sidempuan', callback_data: 'telda_Padang Sidempuan' }],
                            [{ text: 'Rantau Prapat', callback_data: 'telda_Rantau Prapat' }, { text: 'Siantar', callback_data: 'telda_Siantar' }],
                            [{ text: 'Sibolga', callback_data: 'telda_Sibolga' },  {text: 'Toba', callback_data: 'telda_Toba' }]
                        ]
                    }
                });
            }
            else if (session.step === 5) {
                session.data.telkom_daerah = text;
                session.step = 6;
                return ctx.reply(`Tahap 6/10: Masukkan <b>Keterangan Visit</b>:`, { parse_mode: 'HTML' });
            }
            
            else if (session.step === 6) {
                session.data.keterangan_visit = text;
                session.step = 7;
                return ctx.reply('Tahap 7/10: Silakan pilih *Hasil Visit* di bawah ini, atau ketik secara manual:', {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Janji Bayar', callback_data: 'result_Janji Bayar' }, { text: 'LUNAS', callback_data: 'result_LUNAS' }],
                            [{ text: 'Alamat tidak ditemukan', callback_data: 'result_Alamat tidak ditemukan' }],
                            [{ text: 'Usaha tutup / pindah', callback_data: 'result_Usaha sudah tutup / pindah' }],
                            [{ text: 'PIC tidak ada di lokasi', callback_data: 'result_PIC tidak ada di lokasi' }, { text: 'Sudah cabut', callback_data: 'result_Sudah cabut' }],
                            [{ text: 'Permintaan cabut', callback_data: 'result_Permintaan cabut' }],
                            [{ text: 'Komplain / CASE follow up', callback_data: 'result_Komplain / CASE yang perlu di follow up' }]
                        ]
                    }
                });
            }
            else if (session.step === 7) {
                session.data.hasil_visit = text;
                session.step = 8;
                await ctx.reply(`✅ Hasil visit dicatat: <b>${text}</b>\n\n⏳ Memuat daftar petugas aktif...`, { parse_mode: 'HTML' });
                return showPetugasMenu(ctx, pool); // Mengacu pada fungsi pembantu di bawah
            }
            else if (session.step === 8) {
                session.data.nama_petugas = text; 
                session.step = 9;
                return ctx.reply('Tahap 9/10: Silakan kirimkan *Titik Koordinat (Share Location)* 📎', { parse_mode: 'Markdown' });
            }
            else if (session.step === 9) {
                if (!ctx.message.location) return ctx.reply('⚠️ Mohon kirimkan titik lokasi menggunakan fitur Share Location.');
                session.data.latitude = ctx.message.location.latitude;
                session.data.longitude = ctx.message.location.longitude;
                session.step = 10;
                return ctx.reply('Tahap 10/10 (Terakhir): Silakan kirimkan *Gambar / Foto Bukti Visit*.', { parse_mode: 'Markdown' });
            }
            else if (session.step === 10) {
                if (!ctx.message.photo) return ctx.reply('⚠️ Mohon lampirkan foto bukti visit.');
                
                await ctx.reply('⏳ Mengunggah foto ke Cloudinary & mencatat log ke Database...');
                
                try {
                    const photo = ctx.message.photo[ctx.message.photo.length - 1];
                    const fileId = photo.file_id;
                    const d = session.data;
                    
                    // --- UPLOAD KE CLOUDINARY ---
                    const fileLink = await ctx.telegram.getFileLink(fileId);
                    const uploadResult = await cloudinary.uploader.upload(fileLink.href, {
                        folder: 'indibiz_visit',
                        format: 'webp',
                        quality: 'auto'
                    });
                    
                    const fotoUrlCloudinary = uploadResult.secure_url; 

                    // --- ANTI-FRAUD LOGIC ---
                    const realTelegramId = ctx.from.id.toString();

                    // --- SIMPAN KE AIVEN ---
                    await pool.query(
                        `INSERT INTO data_visit 
                        (no_inet, nama_pelanggan, nama_cp, no_cp, telkom_daerah, keterangan_visit, hasil_visit, telegram_id, nama_petugas, latitude, longitude, foto_bukti, waktu_lapor) 
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)`,
                        [
                            d.id_pelanggan, d.nama_pelanggan, d.nama_cp, d.no_cp, d.telkom_daerah, 
                            d.keterangan_visit, d.hasil_visit, realTelegramId, d.nama_petugas, 
                            d.latitude, d.longitude, fotoUrlCloudinary 
                        ]
                    );

                    const rekapPesan = `🎉 <b>Laporan Berhasil Disimpan!</b>\n\n• ID: <code>${d.id_pelanggan}</code>\n• Pelanggan: ${d.nama_pelanggan}\n• CP: ${d.nama_cp}\n• Datel: ${d.telkom_daerah}\n• Hasil: <b>${d.hasil_visit}</b>\n• Petugas: ${d.nama_petugas}\n• Link Foto: <a href="${fotoUrlCloudinary}">Lihat Bukti WebP</a>`;
                    
                    await ctx.replyWithPhoto(fileId, { caption: rekapPesan, parse_mode: 'HTML' });

                    ctx.session.step = 'idle';
                    ctx.session.data = {};
                } catch (err) {
                    console.error('Upload / DB Insert Error:', err);
                    ctx.reply(`❌ Gagal menyimpan data ke server.\nDetail Error: ${err.message}`);
                }
            }
        } catch (err) {
            console.error('Session Error:', err);
            ctx.reply('❌ Terjadi kesalahan sistem internal.');
        }
    });

    // ================= 2. LISTENER KLIK TOMBOL INLINE =================

    bot.action(/^telda_(.+)$/, async (ctx) => {
        const session = ctx.session;
        if (!session || session.step !== 5) return ctx.answerCbQuery('⚠️ Sesi kadaluarsa.', { show_alert: true }); 

        const selectedTelda = ctx.match[1];
        session.data.telkom_daerah = selectedTelda;
        session.step = 6;

        await ctx.answerCbQuery();
        await ctx.editMessageText(`Tahap 5/10: Silakan pilih Telkom Daerah (TelDa) berikut -> <b>${selectedTelda}</b>`, { parse_mode: 'HTML' });
        return ctx.reply(`Tahap 6/10: Masukkan <b>Keterangan Visit</b>:`, { parse_mode: 'HTML' });
    });

    bot.action(/^result_(.+)$/, async (ctx) => {
        const session = ctx.session;
        if (!session || session.step !== 7) return ctx.answerCbQuery('⚠️ Sesi kadaluarsa.', { show_alert: true }); 

        const selectedResult = ctx.match[1];
        session.data.hasil_visit = selectedResult;
        session.step = 8;

        await ctx.answerCbQuery();
        await ctx.editMessageText(`Tahap 7/10: Hasil Visit dipilih -> <b>${selectedResult}</b>`, { parse_mode: 'HTML' });
        return showPetugasMenu(ctx, pool);
    });

    bot.action(/^petugas_(.+)$/, async (ctx) => {
        const session = ctx.session;
        if (!session || session.step !== 8) return ctx.answerCbQuery('⚠️ Sesi kadaluarsa.', { show_alert: true }); 

        const callbackVal = ctx.match[1];
        await ctx.answerCbQuery();

        if (callbackVal === 'manual') {
            return ctx.reply('Silakan ketik nama petugas secara manual di kolom chat:');
        }

        try {
            const res = await pool.query('SELECT nama_petugas FROM petugas WHERE telegram_id = $1', [callbackVal]);
            session.data.nama_petugas = res.rows.length > 0 ? res.rows[0].nama_petugas : 'Petugas';
        } catch (e) {
            session.data.nama_petugas = 'Petugas';
        }
        
        session.step = 9;
        await ctx.editMessageText(`Tahap 8/10: Petugas dipilih -> <b>${session.data.nama_petugas}</b>`, { parse_mode: 'HTML' });
        return ctx.reply('Tahap 9/10: Silakan kirimkan *Titik Koordinat (Share Location)* 📎', { parse_mode: 'Markdown' });
    });

    // ================= 3. FUNGSI PEMBANTU (HELPER) =================
    async function showPetugasMenu(ctx, pool) {
        try {
            const res = await pool.query('SELECT telegram_id, nama_petugas FROM petugas WHERE status_aktif = true');
            const petugasList = res.rows;

            if (petugasList.length === 0) {
                ctx.session.step = 'idle';
                return ctx.reply('❌ Tidak ada petugas aktif di database.');
            }

            const petugasButtons = petugasList.map(p => [
                { text: p.nama_petugas, callback_data: `petugas_${p.telegram_id}` }
            ]);
            petugasButtons.push([{ text: 'Lainnya (Ketik Manual)', callback_data: 'petugas_manual' }]);

            return ctx.reply('Tahap 8/10: Siapa *Petugas* yang melakukan visit ini?', {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: petugasButtons }
            });
        } catch (dbErr) {
            console.error('Error load petugas:', dbErr);
            ctx.session.step = 'idle';
            return ctx.reply('❌ Gagal memuat data petugas.');
        }
    }
};