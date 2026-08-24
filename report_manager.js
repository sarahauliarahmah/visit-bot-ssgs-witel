// report_manager.js
'use strict';

const nodeHtmlToImage = require('node-html-to-image');
const ExcelJS = require('exceljs');

// ==========================================
// KAMUS BULAN & PARSER TANGGAL (PINTAR)
// ==========================================
const monthNames = {
    'januari': 0, 'jan': 0, 'februari': 1, 'feb': 1, 'maret': 2, 'mar': 2,
    'april': 3, 'apr': 3, 'mei': 4, 'juni': 5, 'jun': 5, 'juli': 6, 'jul': 6,
    'agustus': 7, 'agu': 7, 'agus': 7, 'september': 8, 'sep': 8, 'sept': 8,
    'oktober': 9, 'okt': 9, 'november': 10, 'nov': 10, 'desember': 11, 'des': 11
};

function parseCustomDate(input) {
    if (!input) return null;
    let str = input.toLowerCase().trim();

    // UX Tambahan: Kata Kunci Pintasan
    const hariIni = new Date();
    hariIni.setHours(0,0,0,0);
    if (str === 'hari ini' || str === 'hariini' || str === 'today') return hariIni;
    if (str === 'kemarin' || str === 'yesterday') {
        let kemarin = new Date(hariIni);
        kemarin.setDate(kemarin.getDate() - 1);
        return kemarin;
    }

    const textMonthRegex = /^(\d{1,2})[\s\/\-]+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|jun|jul|agu|agus|sep|sept|okt|nov|des)[\s\/\-]+(\d{2,4})$/;
    const matchText = str.match(textMonthRegex);
    if (matchText) {
        let d = parseInt(matchText[1], 10);
        let m = monthNames[matchText[2]];
        let y = parseInt(matchText[3], 10);
        if (y < 100) y += 2000; 
        return new Date(y, m, d);
    }

    const sepRegex = /^(\d{1,2})[\s\/\-]+(\d{1,2})[\s\/\-]+(\d{2,4})$/;
    const matchSep = str.match(sepRegex);
    if (matchSep) {
        let d = parseInt(matchSep[1], 10); let m = parseInt(matchSep[2], 10) - 1; let y = parseInt(matchSep[3], 10);
        if (y < 100) y += 2000;
        return new Date(y, m, d);
    }
    return null;
}

module.exports = (bot, pool) => {

    // =========================================================
    // FITUR 1: RIWAYAT VISIT BERDASARKAN ID PELANGGAN
    // =========================================================
    async function tarikRiwayatId(ctx, idPelanggan) {
        try {
            await ctx.reply(`⏳ Mencari histori visit untuk ID: *${idPelanggan}*...`, { parse_mode: 'Markdown' });

            const query = `
                SELECT v.no_inet, v.nama_pelanggan, v.telkom_daerah, v.hasil_visit, v.keterangan_visit, v.waktu_lapor, v.foto_bukti, p.nama_petugas 
                FROM data_visit v
                LEFT JOIN petugas p ON v.telegram_id::VARCHAR = p.telegram_id::VARCHAR
                WHERE v.no_inet = $1 ORDER BY v.waktu_lapor DESC
            `;
            const res = await pool.query(query, [idPelanggan]);
            
            if (res.rows.length === 0) return ctx.reply(`❌ Histori visit ID *${idPelanggan}* tidak ditemukan.`, { parse_mode: 'Markdown' });

            let pesan = `📝 *Histori Visit - ID: ${idPelanggan}*\n🏢 *Pelanggan:* ${res.rows[0].nama_pelanggan || '-'}\nTotal record: *${res.rows.length}* visit\n\n`;
            
            const batasTampil = Math.min(res.rows.length, 5);
            for (let i = 0; i < batasTampil; i++) {
                const r = res.rows[i];
                const tanggal = new Date(r.waktu_lapor).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
                pesan += `*${i + 1}. ${tanggal} WIB*\n👤 Petugas: ${r.nama_petugas || '-'}\n📌 Hasil: ${r.hasil_visit || '-'}\n💬 Ket: ${r.keterangan_visit || '-'}\n`;
                pesan += r.foto_bukti ? `📸 [Lihat Bukti Foto](${r.foto_bukti})\n` : `📸 Tidak ada foto\n`;
                pesan += `------------------------\n`;
            }
            if (res.rows.length > 5) pesan += `_Menampilkan 5 data terbaru. Gunakan fitur Export Excel untuk selengkapnya._`;

            await ctx.reply(pesan, { parse_mode: 'Markdown', disable_web_page_preview: true });
            ctx.session.step = 'idle';
        } catch (error) {
            console.error('Error Riwayat ID:', error);
            ctx.reply('❌ Terjadi kesalahan database.');
        }
    }

    // =========================================================
    // FITUR 2: REKAPITULASI (MENU UTAMA) DENGAN TOMBOL OUTPUT
    // =========================================================
    async function tarikDataRekap(ctx, textArgs, isAllTime = false) {
        let startMs = 'all', endMs = 'all', labelTanggal = 'Keseluruhan Waktu (Semua Data)';
        
        if (!isAllTime) {
            let start = new Date(); start.setHours(0,0,0,0);
            let end = new Date(start); end.setDate(end.getDate() + 1);

            if (textArgs) {
                if (textArgs.toLowerCase() === 'hari ini' || textArgs.toLowerCase() === 'kemarin') {
                    start = parseCustomDate(textArgs);
                    end = new Date(start); end.setDate(end.getDate() + 1);
                } else {
                    const regexDates = /\b(\d{1,2}[\s\/\-]+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|jun|jul|agu|sep|okt|nov|des)[\s\/\-]+\d{2,4}|\d{1,2}[\s\/\-]+\d{1,2}[\s\/\-]+\d{2,4})\b/gi;
                    let matches = textArgs.match(regexDates);
                    if (matches && matches.length > 0) {
                        let dates = matches.map(m => parseCustomDate(m)).filter(d => d !== null);
                        if (dates.length >= 2) {
                            start = dates[0]; end = dates[1];
                            if (start > end) { let temp = start; start = end; end = temp; }
                            end.setDate(end.getDate() + 1);
                        } else if (dates.length === 1) {
                            start = dates[0]; end = new Date(start); end.setDate(end.getDate() + 1);
                        }
                    } else {
                        return ctx.reply('❌ Format tanggal tidak dikenali. Coba: `hari ini`, `kemarin`, atau `01/08/2026`.', { parse_mode: 'Markdown' });
                    }
                }
            }
            startMs = start.getTime();
            endMs = end.getTime();
            labelTanggal = `${start.toLocaleDateString('id-ID')} s/d ${new Date(endMs - 1).toLocaleDateString('id-ID')}`;
        }

        const queryParams = isAllTime ? [] : [new Date(startMs).toISOString(), new Date(endMs).toISOString()];
        const queryStr = isAllTime 
            ? `SELECT count(*) as total FROM data_visit` 
            : `SELECT count(*) as total FROM data_visit WHERE waktu_lapor >= $1 AND waktu_lapor < $2`;

        try {
            const res = await pool.query(queryStr, queryParams);
            const total = res.rows[0].total;

            if (total == 0) return ctx.reply(`📊 <b>Rekap Visit</b>\nPeriode: ${labelTanggal}\n\n<i>Belum ada laporan masuk.</i>`, { parse_mode: 'HTML' });

            await ctx.reply(
                `📊 <b>Ringkasan Visit Witel Sumut</b>\nPeriode: ${labelTanggal}\nTotal Data: <b>${total} Laporan</b>\n\nPilih format *output* di bawah ini:`, 
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🖼️ Cetak Visual Tabel', callback_data: `cetak_html_${startMs}_${endMs}` }],
                            [{ text: '📥 Download Excel', callback_data: `cetak_excel_${startMs}_${endMs}` }]
                        ]
                    }
                }
            );
        } catch (error) {
            console.error('Error Tarik Rekap:', error);
            ctx.reply('❌ Gagal memeriksa rekap.');
        }
    }

    // =========================================================
    // FUNGSI INTERNAL: Mengambil data aktual berdasarkan parameter Ms
    // =========================================================
    async function _getRawData(startMs, endMs) {
        let queryStr = `SELECT no_inet, nama_pelanggan, nama_cp, no_cp, telkom_daerah, keterangan_visit, hasil_visit, nama_petugas, latitude, longitude, foto_bukti, waktu_lapor FROM data_visit ORDER BY waktu_lapor DESC`;
        let queryParams = [];
        if (startMs !== 'all' && endMs !== 'all') {
            queryStr = `SELECT no_inet, nama_pelanggan, nama_cp, no_cp, telkom_daerah, keterangan_visit, hasil_visit, nama_petugas, latitude, longitude, foto_bukti, waktu_lapor FROM data_visit WHERE waktu_lapor >= $1 AND waktu_lapor < $2 ORDER BY waktu_lapor DESC`;
            queryParams = [new Date(parseInt(startMs)).toISOString(), new Date(parseInt(endMs)).toISOString()];
        }
        const res = await pool.query(queryStr, queryParams);
        return res.rows;
    }

    // =========================================================
    // FITUR 3: GENERATOR HTML -> IMAGE
    // =========================================================
    async function cetakTabelGambar(ctx, startMs, endMs) {
        try {
            const rows = await _getRawData(startMs, endMs);
            if (rows.length === 0) return ctx.reply('⚠️ Data kosong, tidak bisa mencetak tabel.');
            
            // Format ulang label tanggal untuk di HTML
            let labelTanggal = 'Keseluruhan Waktu';
            if (startMs !== 'all' && endMs !== 'all') {
                const startStr = new Date(parseInt(startMs)).toLocaleDateString('id-ID');
                const endStr = new Date(parseInt(endMs) - 1).toLocaleDateString('id-ID');
                labelTanggal = `${startStr} s/d ${endStr}`;
            }

            const rekapArea = {};
            
            // PERBAIKAN: Gunakan variabel 'rows', bukan 'laporanVisit'
            rows.forEach(lap => {
                const area = lap.telkom_daerah || 'Unknown';
                const hasil = lap.hasil_visit || 'Lainnya';
                
                if (!rekapArea[area]) {
                    rekapArea[area] = { 
                        total: 0, janji_bayar: 0, alamat_tidak_ditemukan: 0, 
                        usaha_tutup: 0, komplain: 0, pic_tidak_ada: 0, 
                        sudah_cabut: 0, permintaan_cabut: 0, lokasi_jauh: 0, 
                        lunas: 0, lainnya: 0 
                    };
                }
                
                rekapArea[area].total += 1;
                
                const h = hasil.toLowerCase();
                if (h.includes('janji')) rekapArea[area].janji_bayar += 1;
                else if (h.includes('alamat')) rekapArea[area].alamat_tidak_ditemukan += 1;
                else if (h.includes('tutup') || h.includes('pindah')) rekapArea[area].usaha_tutup += 1;
                else if (h.includes('komplain') || h.includes('case') || h.includes('follow up') || h.includes('fu')) rekapArea[area].komplain += 1;
                else if (h.includes('pic')) rekapArea[area].pic_tidak_ada += 1;
                else if (h === 'sudah cabut' || (h.includes('sudah') && h.includes('cabut'))) rekapArea[area].sudah_cabut += 1;
                else if (h === 'permintaan cabut' || (h.includes('permintaan') && h.includes('cabut')) || h === 'cabut') rekapArea[area].permintaan_cabut += 1;
                else if (h.includes('jauh')) rekapArea[area].lokasi_jauh += 1;
                else if (h.includes('lunas') || h.includes('selesai')) rekapArea[area].lunas += 1;
                else rekapArea[area].lainnya += 1;
            });

            let tableRows = '';
            for (const [area, data] of Object.entries(rekapArea)) {
                tableRows += `
                    <tr>
                        <td style="text-align: left;">${area}</td>
                        <td><b>${data.total}</b></td>
                        <td style="background-color: #dbe5f1;">${data.janji_bayar || '-'}</td>
                        <td style="background-color: #f2dcdb;">${data.alamat_tidak_ditemukan || '-'}</td>
                        <td style="background-color: #f2dcdb;">${data.usaha_tutup || '-'}</td>
                        <td style="background-color: #f2dcdb;">${data.komplain || '-'}</td>
                        <td style="background-color: #f2dcdb;">${data.pic_tidak_ada || '-'}</td>
                        <td>${data.sudah_cabut || '-'}</td>
                        <td>${data.permintaan_cabut || '-'}</td>
                        <td style="background-color: #f2dcdb;">${data.lokasi_jauh || '-'}</td>
                        <td>${data.lunas || '-'}</td>
                        <td>${data.lainnya || '-'}</td>
                    </tr>
                `;
            }

            const htmlTemplate = `
                <html>
                    <head>
                        <style>
                            body { font-family: Arial, sans-serif; padding: 20px; width: 1200px; background: white;}
                            h2 { text-align: center; font-size: 18px; margin-bottom: 5px; }
                            h3 { text-align: center; font-size: 14px; margin-top: 0; color: #333; margin-bottom: 20px; }
                            table { width: 100%; border-collapse: collapse; font-size: 12px; text-align: center; }
                            th, td { border: 1px solid #000; padding: 6px; }
                            th { background-color: #174f76; color: white; font-weight: bold; }
                            .hasil-header { background-color: #174f76; }
                        </style>
                    </head>
                    <body>
                        <h2>REKAP VISIT PRACTO WITEL SUMUT</h2>
                        <h3>Periode: ${labelTanggal}</h3>
                        <table>
                            <thead>
                                <tr>
                                    <th rowspan="2" style="width: 15%;">DATEL</th>
                                    <th rowspan="2" style="width: 7%;">TOTAL VISIT</th>
                                    <th colspan="10" class="hasil-header">HASIL VISIT</th>
                                </tr>
                                <tr>
                                    <th style="background-color: #dbe5f1; color: black; width: 8%;">Janji Bayar</th>
                                    <th style="background-color: #f2dcdb; color: black; width: 8%;">Alamat Tdk Ditemukan</th>
                                    <th style="background-color: #f2dcdb; color: black; width: 8%;">Usaha Tutup/Pindah</th>
                                    <th style="background-color: #f2dcdb; color: black; width: 8%;">Komplain / FU</th>
                                    <th style="background-color: #f2dcdb; color: black; width: 8%;">PIC Tdk di Lokasi</th>
                                    <th style="background-color: white; color: black; width: 8%;">Sudah Cabut</th>
                                    <th style="background-color: white; color: black; width: 8%;">Permintaan Cabut</th>
                                    <th style="background-color: #f2dcdb; color: black; width: 8%;">Lokasi Terlalu Jauh</th>
                                    <th style="background-color: white; color: black; width: 7%;">LUNAS</th>
                                    <th style="background-color: white; color: black; width: 7%;">Lainnya</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${tableRows}
                            </tbody>
                        </table>
                    </body>
                </html>
            `;

            const imageBuffer = await nodeHtmlToImage({ html: htmlTemplate });

            await ctx.replyWithPhoto({ source: imageBuffer }, {
                caption: `📊 Tabel Rekap Visit Witel Sumut (${labelTanggal})`
            });

        } catch (error) {
            console.error('Error saat mencetak gambar:', error);
            ctx.reply('❌ Gagal meng-generate gambar tabel.');
        }
    }

    // =========================================================
    // FITUR 4: GENERATOR EXCELJS (Dilengkapi Hyperlink Cloudinary)
    // =========================================================
    async function cetakExcel(ctx, startMs, endMs) {
        try {
            const rows = await _getRawData(startMs, endMs);
            if (rows.length === 0) return ctx.reply('⚠️ Data kosong, tidak ada yang bisa di-export.');

            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Laporan Visit');
            
            worksheet.columns = [
                { header: 'NO', key: 'no', width: 5 },
                { header: 'WAKTU LAPOR', key: 'waktu', width: 22 },
                { header: 'DATEL', key: 'datel', width: 15 },
                { header: 'ID PELANGGAN', key: 'inet', width: 18 },
                { header: 'HASIL', key: 'hasil', width: 20 },
                { header: 'BUKTI FOTO', key: 'foto', width: 25 } 
            ];

            worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
            worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF174F76' } };

            rows.forEach((r, i) => {
                const waktuWIB = new Date(r.waktu_lapor).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
                
                const fotoLink = r.foto_bukti 
                    ? { text: '📸 Lihat Foto', hyperlink: r.foto_bukti } 
                    : 'Tidak ada foto';

                worksheet.addRow({ no: i + 1, waktu: waktuWIB, datel: r.telkom_daerah, inet: r.no_inet, hasil: r.hasil_visit, foto: fotoLink });
            });

            worksheet.getColumn('foto').font = { color: { argb: 'FF0563C1' }, underline: true };
            
            const buffer = await workbook.xlsx.writeBuffer();
            await ctx.replyWithDocument(
                { source: buffer, filename: `Export_Visit.xlsx` },
                { caption: `✅ <b>Export Berhasil!</b> (${rows.length} data)`, parse_mode: 'HTML' }
            );
        } catch (error) {
            console.error('Error saat membuat Excel:', error);
            ctx.reply('❌ Terjadi kesalahan saat membuat file Excel.');
        }
    }

    return { tarikRiwayatId, tarikDataRekap, cetakTabelGambar, cetakExcel };
};