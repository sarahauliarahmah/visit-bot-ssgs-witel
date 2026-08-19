'use strict';

const ExcelJS = require('exceljs');

module.exports = (bot, pool) => {
    
    // Fungsi Inti Export Excel
    async function prosesExportExcel(ctx, args) {
        try {
            await ctx.reply('⏳ Menyiapkan data dan merangkai dokumen Excel... Mohon tunggu.');

            // Tarik seluruh data dari database Aiven, urutkan dari yang terbaru
            const query = `
                SELECT no_inet, nama_pelanggan, nama_cp, no_cp, telkom_daerah, 
                       keterangan_visit, hasil_visit, nama_petugas, latitude, longitude, 
                       foto_bukti, waktu_lapor
                FROM data_visit 
                ORDER BY waktu_lapor DESC
            `;
            
            const res = await pool.query(query);

            if (res.rows.length === 0) {
                return ctx.reply('⚠️ Belum ada data laporan visit di dalam database.');
            }

            // 1. Inisiasi Workbook & Worksheet baru
            const workbook = new ExcelJS.Workbook();
            workbook.creator = 'Bot Visit Indibiz';
            const worksheet = workbook.addWorksheet('Rekap Laporan Visit');

            // 2. Definisi Header & Ukuran Kolom
            worksheet.columns = [
                { header: 'NO', key: 'no', width: 5 },
                { header: 'WAKTU LAPOR', key: 'waktu_lapor', width: 22 },
                { header: 'DATEL', key: 'telkom_daerah', width: 15 },
                { header: 'ID PELANGGAN', key: 'no_inet', width: 18 },
                { header: 'NAMA PELANGGAN', key: 'nama_pelanggan', width: 30 },
                { header: 'HASIL VISIT', key: 'hasil_visit', width: 20 },
                { header: 'KETERANGAN', key: 'keterangan_visit', width: 35 },
                { header: 'PETUGAS', key: 'nama_petugas', width: 20 },
                { header: 'NAMA CP', key: 'nama_cp', width: 20 },
                { header: 'NO CP', key: 'no_cp', width: 18 },
                { header: 'LATITUDE', key: 'latitude', width: 15 },
                { header: 'LONGITUDE', key: 'longitude', width: 15 },
                { header: 'LINK BUKTI (CLOUDINARY)', key: 'foto_bukti', width: 45 }
            ];

            // 3. Styling Header (Warna biru gelap, teks putih, bold)
            worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
            worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
            worksheet.getRow(1).fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF174F76' } // Warna biru elegan khas korporat
            };

            // 4. Masukkan Data ke Baris
            res.rows.forEach((row, index) => {
                const tanggalWIB = new Date(row.waktu_lapor).toLocaleString('id-ID', {
                    timeZone: 'Asia/Jakarta',
                    day: '2-digit', month: '2-digit', year: 'numeric',
                    hour: '2-digit', minute: '2-digit', second: '2-digit'
                });

                worksheet.addRow({
                    no: index + 1,
                    waktu_lapor: tanggalWIB,
                    telkom_daerah: row.telkom_daerah,
                    no_inet: row.no_inet,
                    nama_pelanggan: row.nama_pelanggan,
                    hasil_visit: row.hasil_visit,
                    keterangan_visit: row.keterangan_visit,
                    nama_petugas: row.nama_petugas,
                    nama_cp: row.nama_cp,
                    no_cp: row.no_cp,
                    latitude: row.latitude,
                    longitude: row.longitude,
                    foto_bukti: row.foto_bukti || 'Tidak ada foto'
                });
            });

            // 5. Tambahkan Border ke semua Cell yang terisi
            worksheet.eachRow((row) => {
                row.eachCell((cell) => {
                    cell.border = {
                        top: { style: 'thin' },
                        left: { style: 'thin' },
                        bottom: { style: 'thin' },
                        right: { style: 'thin' }
                    };
                });
            });

            // 6. Konversi Workbook menjadi Buffer Biner
            const buffer = await workbook.xlsx.writeBuffer();

            // 7. Penamaan File dan Pengiriman ke Telegram
            const tanggalSekarang = new Date().toISOString().slice(0, 10);
            const namaFile = `Rekap_Visit_${tanggalSekarang}.xlsx`;

            await ctx.replyWithDocument(
                { source: buffer, filename: namaFile },
                { caption: `✅ <b>Export Excel Berhasil!</b>\n\nTotal data terekap: <b>${res.rows.length}</b> laporan.\nSilakan unduh file di atas. 👆`, parse_mode: 'HTML' }
            );

        } catch (error) {
            console.error('Error saat membuat Excel:', error);
            ctx.reply('❌ Terjadi kesalahan sistem saat mencoba men-generate file Excel.');
        }
    }

    // Command Teks Manual
    bot.command('excel_export', async (ctx) => {
        const args = ctx.message.text.split(' ').slice(1);
        // Argumen ini nantinya bisa kamu kembangkan untuk memfilter bulan/tahun tertentu
        await prosesExportExcel(ctx, args);
    });

    // Ekspor fungsi agar bisa dipanggil oleh tombol di menu utama
    return { prosesExportExcel };
};