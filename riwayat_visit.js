'use strict';

module.exports = function (bot, pool) {
    
    // ================= 1. COMMAND AWAL MEMINTA ID =================
    bot.command('riwayat_visit', async (ctx) => {
        const session = ctx.session;
        
        const inputTeks = ctx.message.text.split(' ');
        if (inputTeks.length > 1) {
            const idPelanggan = inputTeks[1].trim();
            return prosesRiwayat(ctx, pool, idPelanggan);
        }

        session.step = 'menunggu_id_riwayat_visit';
        ctx.reply('🔍 Masukkan *ID Pelanggan / No. Internet* untuk melihat histori visitnya:', { parse_mode: 'Markdown' });
    });

    // ================= 2. HANDLER MENANGKAP BALASAN ID =================
    bot.on('message', async (ctx, next) => {
        const session = ctx.session;
        const text = ctx.message.text ? ctx.message.text.trim() : '';

        if (text.startsWith('/')) return next();
        if (!session || session.step !== 'menunggu_id_riwayat_visit') return next();

        await prosesRiwayat(ctx, pool, text);
    });

    // ================= 3. FUNGSI UTAMA (PENCARIAN DATABASE) =================
    async function prosesRiwayat(ctx, pool, idPelanggan) {
        try {
            await ctx.reply(`⏳ Sedang mencari histori visit untuk ID: *${idPelanggan}*...`, { parse_mode: 'Markdown' });

            const query = `
                SELECT v.no_inet, v.nama_pelanggan, v.telkom_daerah, v.hasil_visit, v.keterangan_visit, v.waktu_lapor, v.foto_bukti, p.nama_petugas 
                FROM data_visit v
                LEFT JOIN petugas p ON v.telegram_id::VARCHAR = p.telegram_id::VARCHAR
                WHERE v.no_inet = $1
                ORDER BY v.waktu_lapor DESC
            `;
            
            const res = await pool.query(query, [idPelanggan]);
            const riwayat = res.rows;

            if (riwayat.length === 0) {
                await ctx.reply(`❌ Tidak ditemukan histori visit untuk ID *${idPelanggan}*.`, { parse_mode: 'Markdown' });
            } else {
                let pesan = `📝 *Histori Visit - ID: ${idPelanggan}*\n`;
                pesan += `🏢 *Pelanggan:* ${riwayat[0].nama_pelanggan || '-'}\n`; 
                pesan += `Total record: *${riwayat.length}* kali visit\n\n`;

                const batasTampil = Math.min(riwayat.length, 5);

                for (let i = 0; i < batasTampil; i++) {
                    const r = riwayat[i];
                    
                    const tanggal = new Date(r.waktu_lapor).toLocaleString('id-ID', {
                        timeZone: 'Asia/Jakarta',
                        day: '2-digit', month: 'long', year: 'numeric',
                        hour: '2-digit', minute: '2-digit'
                    });

                    pesan += `*${i + 1}. Tanggal:* ${tanggal} WIB\n`;
                    pesan += `👤 *Petugas:* ${r.nama_petugas || 'Tidak diketahui'}\n`;
                    pesan += `📍 *Datel:* ${r.telkom_daerah || '-'}\n`;
                    pesan += `📌 *Hasil:* ${r.hasil_visit || '-'}\n`;
                    pesan += `💬 *Ket:* ${r.keterangan_visit || '-'}\n`;
                    
                    // PENYESUAIAN CLOUDINARY: Menampilkan link URL teks langsung dari database
                    if (r.foto_bukti) {
                        pesan += `📸 *Foto:* [Klik untuk Lihat Bukti WebP](${r.foto_bukti})\n`;
                    } else {
                        pesan += `📸 *Foto:* Tidak ada\n`;
                    }
                    pesan += `-----------------------------------\n`;
                }

                if (riwayat.length > 5) {
                    pesan += `\n_Menampilkan 5 visit terbaru. Untuk riwayat lebih lengkap, silakan gunakan fitur export Excel._`;
                }

                // Mengirim pesan secara utuh. disable_web_page_preview diaktifkan agar 
                // link gambar tidak termuat otomatis menjadi kotak besar yang memenuhi layar chat.
                await ctx.reply(pesan, { 
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true 
                });
            }

            ctx.session.step = 'idle';

        } catch (error) {
            console.error('Error saat menarik data riwayat visit:', error);
            ctx.reply('❌ Terjadi kesalahan sistem saat mengambil data dari database.');
            ctx.session.step = 'idle';
        }
    }
};