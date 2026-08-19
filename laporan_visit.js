'use strict';

const nodeHtmlToImage = require('node-html-to-image');

// ==========================================
// KAMUS BULAN & CUSTOM DATE PARSER
// ==========================================
const monthNames = {
    'januari': 0, 'jan': 0,
    'februari': 1, 'feb': 1,
    'maret': 2, 'mar': 2,
    'april': 3, 'apr': 3,
    'mei': 4,
    'juni': 5, 'jun': 5,
    'juli': 6, 'jul': 6,
    'agustus': 7, 'agu': 7, 'agus': 7,
    'september': 8, 'sep': 8, 'sept': 8,
    'oktober': 9, 'okt': 9,
    'november': 10, 'nov': 10,
    'desember': 11, 'des': 11
};

function parseCustomDate(input) {
    if (!input) return null;
    let str = input.toLowerCase().trim();
    
    const textMonthRegex = /^(\d{1,2})[\s\/\-]+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|jun|jul|agu|agus|sep|sept|okt|nov|des)[\s\/\-]+(\d{2,4})$/;
    const matchText = str.match(textMonthRegex);
    if (matchText) {
        let d = parseInt(matchText[1], 10);
        let m = monthNames[matchText[2]];
        let y = parseInt(matchText[3], 10);
        if (y < 100) y += 2000; 
        else if (y >= 200 && y <= 209) y = 2020 + (y % 10);
        else if (y < 1000) y += 2000;
        return new Date(y, m, d);
    }

    const sepRegex = /^(\d{1,2})[\s\/\-]+(\d{1,2})[\s\/\-]+(\d{2,4})$/;
    const matchSep = str.match(sepRegex);
    if (matchSep) {
        let d = parseInt(matchSep[1], 10);
        let m = parseInt(matchSep[2], 10) - 1;
        let y = parseInt(matchSep[3], 10);
        if (y < 100) y += 2000;
        else if (y >= 200 && y <= 209) y = 2020 + (y % 10);
        return new Date(y, m, d);
    }

    const mergedRegex = /^(\d{6,8})$/;
    const matchMerged = str.match(mergedRegex);
    if (matchMerged) {
        let s = matchMerged[1];
        let d, m, y;
        if (s.length === 8) {
            d = parseInt(s.substring(0, 2), 10);
            m = parseInt(s.substring(2, 4), 10) - 1;
            y = parseInt(s.substring(4, 8), 10);
        } else if (s.length === 6) {
            if (s.substring(2, 4) === '20') { 
                d = parseInt(s.substring(0, 1), 10);
                m = parseInt(s.substring(1, 2), 10) - 1;
                y = parseInt(s.substring(2, 6), 10);
            } else {
                d = parseInt(s.substring(0, 2), 10);
                m = parseInt(s.substring(2, 4), 10) - 1;
                y = 2000 + parseInt(s.substring(4, 6), 10);
            }
        } else if (s.length === 7) {
            y = parseInt(s.substring(3, 7), 10);
            let d1 = parseInt(s.substring(0, 2), 10); let m1 = parseInt(s.substring(2, 3), 10) - 1; 
            let d2 = parseInt(s.substring(0, 1), 10); let m2 = parseInt(s.substring(1, 3), 10) - 1; 
            const isValidDate = (day, month, year) => {
                if (month < 0 || month > 11) return false;
                return day >= 1 && day <= new Date(year, month + 1, 0).getDate();
            };
            if (isValidDate(d1, m1, y) && !isValidDate(d2, m2, y)) { d = d1; m = m1; } 
            else if (!isValidDate(d1, m1, y) && isValidDate(d2, m2, y)) { d = d2; m = m2; } 
            else { d = d1; m = m1; }
        }
        return new Date(y, m, d);
    }
    return null;
}

// ==========================================
// MODULE EXPORT TELEGRAM BOT
// ==========================================
module.exports = (bot, pool) => {
    
    // Fungsi utama pemrosesan laporan (Ditambah parameter isAllTime)
    async function prosesLaporan(ctx, textArgs, isAllTime = false) {
        let labelTanggal = '';
        let query = '';
        let queryParams = [];
        const tglOptions = { day: '2-digit', month: 'long', year: 'numeric' }; 

        // 1. Cek Mode: Apakah ditarik dari tombol (Semua Data) atau Command (Filter Manual)
        if (isAllTime) {
            labelTanggal = 'Keseluruhan Waktu (Semua Data)';
            // Kueri tanpa klausa WHERE agar semua data tertarik
            query = `SELECT no_inet, telkom_daerah, hasil_visit FROM data_visit`;
            queryParams = []; 
        } else {
            let start = new Date();
            let end = new Date();

            if (textArgs) {
                const regexExtract = /\b(\d{1,2}[\s\/\-]+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|jun|jul|agu|agus|sep|sept|okt|nov|des)[\s\/\-]+\d{2,4}|\d{1,2}[\s\/\-]+\d{1,2}[\s\/\-]+\d{2,4}|\d{6,8})\b/gi;
                let matches = textArgs.match(regexExtract);
                
                if (matches && matches.length > 0) {
                    let dates = matches.map(m => parseCustomDate(m)).filter(d => d !== null && !isNaN(d.getTime()));
                    
                    if (dates.length >= 2) {
                        start = dates[0];
                        end = dates[1];
                        if (start > end) { let temp = start; start = end; end = temp; }
                        labelTanggal = `${start.toLocaleDateString('id-ID', tglOptions)} s/d ${end.toLocaleDateString('id-ID', tglOptions)}`;
                        end.setDate(end.getDate() + 1); 
                    } else if (dates.length === 1) {
                        start = dates[0];
                        labelTanggal = start.toLocaleDateString('id-ID', tglOptions);
                        end = new Date(start);
                        end.setDate(end.getDate() + 1);
                    }
                } else {
                    return ctx.reply('❌ Format tanggal tidak dikenali. \nContoh yang valid:\n- 03 08 2026\n- 03/08/2026\n- 03 Agustus 2026');
                }
            } else {
                // Default fallback jika command diketik tanpa tanggal: Hari ini
                start.setHours(0, 0, 0, 0);
                end = new Date(start);
                end.setDate(end.getDate() + 1);
                labelTanggal = start.toLocaleDateString('id-ID', tglOptions);
            }

            // Kueri dengan klausa WHERE untuk rentang waktu
            query = `
                SELECT no_inet, telkom_daerah, hasil_visit 
                FROM data_visit 
                WHERE waktu_lapor >= $1 AND waktu_lapor < $2
            `;
            queryParams = [start.toISOString(), end.toISOString()];
        }

        ctx.reply(`⏳ Sedang menarik dan menyusun rekap tabel visit untuk: ${labelTanggal}...`);
        
        try {
            // Eksekusi Kueri PostgreSQL
            const res = await pool.query(query, queryParams);
            const laporanVisit = res.rows;

            if (laporanVisit.length === 0) {
                return ctx.replyWithHTML(`📊 <b>Rekap Visit Witel Sumut</b>\nPeriode: ${labelTanggal}\n\n<i>Belum ada laporan visit yang masuk pada periode tersebut.</i>`);
            }

            let pesanDetail = `📊 <b>Rekap Visit Witel Sumut</b>\nPeriode: ${labelTanggal}\n\n`;
            pesanDetail += `Total Visit: ${laporanVisit.length} pelanggan\n\n`;

            laporanVisit.forEach((lap, index) => {
                pesanDetail += `${index + 1}. ID: <code>${lap.no_inet}</code>\n`;
                pesanDetail += `   Area: ${lap.telkom_daerah || '-'}\n`;
                pesanDetail += `   Hasil: ${lap.hasil_visit || '-'}\n\n`;
            });

            // Agregasi Data Tabel
            const rekapArea = {};
            laporanVisit.forEach(lap => {
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

            await ctx.replyWithHTML(pesanDetail);

        } catch (error) {
            console.error('Error saat menarik laporan manual:', error);
            ctx.reply('❌ Gagal menarik rekap data dari database Aiven. Pastikan format tanggal benar.');
        }
    }

    // Trigger dari Command Teks (Filter Manual via /laporan_manual)
    bot.command('laporan_manual', async (ctx) => {
        const messageText = ctx.message.text;
        const textArgs = messageText.replace(/^\/laporan_manual(?:@[a-zA-Z0-9_]+)?\s*/i, '').trim();
        // Parameter ketiga adalah false (secara default), sehingga akan masuk ke logika filter waktu
        await prosesLaporan(ctx, textArgs, false);
    });

    // Menarik fungsi ini agar bisa diekspor dan digunakan oleh tombol di index.js
    return { prosesLaporan };
};