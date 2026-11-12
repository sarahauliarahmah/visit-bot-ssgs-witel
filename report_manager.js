const nodeHtmlToImage = require('node-html-to-image');
const { Markup } = require('telegraf');
const { isAdmin } = require('./daftar_petugas');
const ExcelJS = require('exceljs');

// ============================================================================
// report_manager.js -- Fitur LAPORAN VISIT (rekap + export) & RIWAYAT VISIT.
// Khusus admin & master_admin. Karyawan visit TIDAK bisa mengakses file ini.
//
// UX BARU (berbasis tombol, tanpa mengetik ulang command):
//
// 📊 Laporan Visit (/laporan_visit):
//   bot -> tombol pilihan periode [Semua Data] [Hari Ini] / [Kemarin] [Ketik Tanggal Manual]
//   admin klik periode (atau ketik rentang tanggal)
//   bot -> tombol pilihan format export [🖼️ PNG (Gambar)] / [📊 Excel (.xlsx)]
//   admin klik format -> bot kirim hasil (desain output tidak diubah)
//
// 📝 Riwayat Visit (/riwayat_visit):
//   bot -> "Silakan masukkan ID Pelanggan:" (ketik ID saja)
//   user ketik ID (boleh sekalian diikuti tanggal/rentang)
//   bot -> tombol pilihan periode (sama seperti di atas)
//   admin klik periode -> bot kirim hasil (Excel + detail teks)
//
// Command dengan argumen tetap didukung sebagai jalan pintas:
//   /laporan_visit 05 11 2026        -> langsung ke pilihan format
//   /riwayat_visit 111201107052      -> langsung ke pilihan periode
//   /riwayat_visit 111201107052 01 11 2026 05 11 2026 -> langsung hasil
// ============================================================================

// Label tombol menu utama (pengaman input bertahap).
const MENU_LABELS = ['📋 Lapor Visit', '📊 Laporan Visit', '📝 Riwayat Visit', '👥 Daftar Petugas', '⚙️ Atur Role', 'ℹ️ Bantuan', '📝 Daftar Akun'];

const monthNames = {
    januari: 0, jan: 0, februari: 1, feb: 1, maret: 2, mar: 2,
    april: 3, apr: 3, mei: 4, juni: 5, jun: 5, juli: 6, jul: 6,
    agustus: 7, agu: 7, september: 8, sep: 8, sept: 8,
    oktober: 9, okt: 9, november: 10, nov: 10, desember: 11, des: 11
};

// Parser tanggal super-toleran (diadaptasi dari laporan_manual.js project lama)
function parseCustomDate(input) {
    if (!input) return null;
    const str = input.toLowerCase().trim();

    // "03 agustus 2026"
    let m = str.match(/^(\d{1,2})[\s\/\-]+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|jun|jul|agu|sep|sept|okt|nov|des)[\s\/\-]+(\d{2,4})$/);
    if (m) {
        let d = parseInt(m[1], 10), mo = monthNames[m[2]], y = parseInt(m[3], 10);
        if (y < 100) y += 2000;
        else if (y >= 200 && y <= 209) y = 2020 + (y % 10); // typo: 206 -> 2026
        else if (y < 1000) y += 2000;
        return new Date(y, mo, d);
    }

    // "03/08/2026", "3-8-2026"
    m = str.match(/^(\d{1,2})[\s\/\-]+(\d{1,2})[\s\/\-]+(\d{2,4})$/);
    if (m) {
        let d = parseInt(m[1], 10), mo = parseInt(m[2], 10) - 1, y = parseInt(m[3], 10);
        if (y < 100) y += 2000;
        else if (y >= 200 && y <= 209) y = 2020 + (y % 10);
        return new Date(y, mo, d);
    }

    // "03082026" (8 digit) / "382026" (6 digit)
    m = str.match(/^(\d{6,8})$/);
    if (m) {
        const s = m[1];
        let d, mo, y;
        if (s.length === 8) {
            d = parseInt(s.substring(0, 2), 10);
            mo = parseInt(s.substring(2, 4), 10) - 1;
            y = parseInt(s.substring(4, 8), 10);
        } else {
            if (s.substring(2, 4) === '20') {
                d = parseInt(s.substring(0, 1), 10);
                mo = parseInt(s.substring(1, 2), 10) - 1;
                y = parseInt(s.substring(2, 6), 10);
            } else {
                d = parseInt(s.substring(0, 2), 10);
                mo = parseInt(s.substring(2, 4), 10) - 1;
                y = 2000 + parseInt(s.substring(4, 6), 10);
            }
        }
        return new Date(y, mo, d);
    }
    return null;
}

// Mengurai argumen/ketikan bebas menjadi filter periode:
//   { mode: 'kosong' }                      -> belum ada tanggal (tampilkan tombol periode)
//   { mode: 'gagal' }                       -> teks ada tapi bukan tanggal valid
//   { mode: 'satu', start, end, label }     -> 1 hari (end = hari berikutnya, eksklusif)
//   { mode: 'rentang', start, end, label }  -> rentang (end = hari setelah akhir, eksklusif)
function parseArgsPeriode(args) {
    const gabung = args.join(' ');
    if (!gabung.trim()) return { mode: 'kosong' };

    const tokens = gabung.split(/\s+/);

    // Coba: 1 tanggal
    if (tokens.length <= 3) {
        const satu = parseCustomDate(gabung);
        if (satu) {
            const end = new Date(satu); end.setDate(end.getDate() + 1);
            return { mode: 'satu', start: satu, end, label: formatLabel(satu) };
        }
    }

    // Coba: 2 tanggal berturut (rentang) -- cari pembagian token yang valid
    for (let i = 1; i < tokens.length; i++) {
        const tgl1 = parseCustomDate(tokens.slice(0, i).join(' '));
        const tgl2 = parseCustomDate(tokens.slice(i).join(' '));
        if (tgl1 && tgl2) {
            let start = tgl1, end = tgl2;
            if (start > end) { const tmp = start; start = end; end = tmp; }
            const endExclusive = new Date(end); endExclusive.setDate(endExclusive.getDate() + 1);
            return {
                mode: 'rentang', start, end: endExclusive,
                label: `${formatLabel(start)} s/d ${formatLabel(end)}`
            };
        }
    }

    return { mode: 'gagal' };
}

// Mengubah kolom `koordinat` (GeoJSON / WKT "POINT(lon lat)" / hex EWKB)
// menjadi link Google Maps yang bisa diklik. Return null kalau tidak terbaca.
function koordinatKeLink(koordinat) {
    if (!koordinat) return null;
    let lat = null, lon = null;
    try {
        if (typeof koordinat === 'object' && Array.isArray(koordinat.coordinates)) {
            [lon, lat] = koordinat.coordinates;
        } else if (typeof koordinat === 'string') {
            const s = koordinat.trim();
            const wkt = s.match(/POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
            if (wkt) {
                lon = parseFloat(wkt[1]); lat = parseFloat(wkt[2]);
            } else if (/^[0-9a-fA-F]+$/.test(s) && s.length >= 42) {
                // Hex EWKB Point: [endian 1][type 4][srid 4 bila ada][x 8][y 8]
                const buf = Buffer.from(s, 'hex');
                const le = buf[0] === 1;
                const tipe = le ? buf.readUInt32LE(1) : buf.readUInt32BE(1);
                const offset = (tipe & 0x20000000) ? 9 : 5;
                lon = le ? buf.readDoubleLE(offset) : buf.readDoubleBE(offset);
                lat = le ? buf.readDoubleLE(offset + 8) : buf.readDoubleBE(offset + 8);
            }
        }
    } catch (e) {
        return null;
    }
    if (typeof lat !== 'number' || typeof lon !== 'number' || isNaN(lat) || isNaN(lon)) return null;
    return `https://maps.google.com/?q=${lat},${lon}`;
}

function formatLabel(d) {
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
}

// Periode disimpan di session sebagai object polos (aman diserialisasi).
function serializePeriode(p) {
    return {
        mode: p.mode,
        startISO: p.start ? p.start.toISOString() : null,
        endISO: p.end ? p.end.toISOString() : null,
        label: p.label || 'SELURUH DATA'
    };
}

// Preset tanggal cepat untuk tombol inline
function periodeDariPreset(pilihan) {
    const now = new Date();
    if (pilihan === 'semua') return { mode: 'semua', label: 'SELURUH DATA' };
    const offset = pilihan === 'hari_ini' ? 0 : -1;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return { mode: 'satu', start, end, label: formatLabel(start) };
}

// Keyboard pilihan filter periode (tombol inline)
function keyboardPeriode(prefix) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('📅 Hari Ini', `${prefix}_hari_ini`),
            Markup.button.callback('📅 Kemarin', `${prefix}_kemarin`)
        ],
        [
            Markup.button.callback('🗂️ Semua Data', `${prefix}_semua`),
            Markup.button.callback('📝 Ketik Tanggal Manual', `${prefix}_manual`)
        ]
    ]);
}

// Agregasi hasil visit per area (untuk tabel gambar & sheet rekap Excel)
const KATEGORI_HASIL = [
    { key: 'janji_bayar', label: 'Janji Bayar', match: h => h.includes('janji') },
    { key: 'lunas', label: 'LUNAS', match: h => h.includes('lunas') || h.includes('selesai') },
    { key: 'alamat', label: 'Alamat Tdk Ditemukan', match: h => h.includes('alamat') },
    { key: 'tutup', label: 'Usaha Tutup/Pindah', match: h => h.includes('tutup') || h.includes('pindah') },
    { key: 'pic', label: 'PIC Tdk di Lokasi', match: h => h.includes('pic') },
    { key: 'sudah_cabut', label: 'Sudah Cabut', match: h => h.includes('sudah') && h.includes('cabut') },
    { key: 'permintaan_cabut', label: 'Permintaan Cabut', match: h => h.includes('cabut') && !h.includes('sudah') },
    { key: 'jauh', label: 'Lokasi Jauh', match: h => h.includes('jauh') },
    { key: 'komplain', label: 'Komplain / FU', match: h => h.includes('komplain') || h.includes('case') || h.includes('follow') }
];

function agregasiPerArea(rows) {
    const rekap = {};
    for (const r of rows) {
        const area = r.nama_telkom_daerah || 'Unknown';
        const h = (r.hasil_visit || '').toLowerCase();
        if (!rekap[area]) {
            rekap[area] = { total: 0 };
            KATEGORI_HASIL.forEach(k => { rekap[area][k.key] = 0; });
        }
        rekap[area].total += 1;
        const ketemu = KATEGORI_HASIL.find(k => k.match(h));
        if (ketemu) rekap[area][ketemu.key] += 1;
    }
    return rekap;
}

async function kirimGambarRekap(ctx, rekapArea, labelPeriode) {
    const kolomHasil = KATEGORI_HASIL.map(k => `<th>${k.label}</th>`).join('');

    let baris = '';
    for (const [area, d] of Object.entries(rekapArea)) {
        baris += `<tr><td style="text-align:left">${area}</td><td><b>${d.total}</b></td>` +
            KATEGORI_HASIL.map(k => `<td>${d[k.key] || '-'}</td>`).join('') + '</tr>';
    }

    const html = `
<html><head><style>
    body { font-family: Arial, sans-serif; padding: 20px; width: 1200px; background: white; }
    h2 { text-align: center; font-size: 18px; margin-bottom: 5px; }
    h3 { text-align: center; font-size: 13px; margin-top: 0; color: #333; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; text-align: center; }
    th, td { border: 1px solid #000; padding: 6px; }
    th { background-color: #174f76; color: white; }
</style></head><body>
    <h2>REKAP LAPORAN VISIT</h2>
    <h3>Periode: ${labelPeriode}</h3>
    <table>
        <thead><tr><th style="width:15%">AREA</th><th>TOTAL</th>${kolomHasil}</tr></thead>
        <tbody>${baris}</tbody>
    </table>
</body></html>`;

    const imageBuffer = await nodeHtmlToImage({ html });
    await ctx.replyWithPhoto({ source: imageBuffer }, {
        caption: `Tabel Rekap Visit (${labelPeriode})`
    });
}

function detailTeks(rows, labelPeriode, judul) {
    let teks = `${judul}\nPeriode: ${labelPeriode}\nTotal Visit: ${rows.length} pelanggan\n\n`;
    rows.forEach((r, i) => {
        const waktu = new Date(r.waktu_visit).toLocaleString('id-ID', {
            timeZone: 'Asia/Jakarta', day: '2-digit', month: 'long', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
        teks += `${i + 1}. ID: ${r.id_pelanggan}\n`;
        teks += `   Waktu: ${waktu} WIB\n`;
        teks += `   Petugas: ${r.nama_petugas || '-'}\n`;
        teks += `   Area: ${r.nama_telkom_daerah || '-'}\n`;
        teks += `   Hasil: ${r.hasil_visit || '-'}\n`;
        teks += `   Ket: ${r.keterangan || '-'}\n`;
        const linkMaps = koordinatKeLink(r.koordinat);
        if (linkMaps) teks += `   Koordinat: ${linkMaps}\n`;
        if (r.foto_url) teks += `   Foto: ${r.foto_url}\n`;
        teks += '-----------------------------------\n';
    });
    return teks;
}

// Potong teks detail supaya tidak melewati batas 4096 karakter per pesan
async function kirimDetail(ctx, teks) {
    const BATAS = 3500;
    if (teks.length <= BATAS) {
        await ctx.reply(teks, { disable_web_page_preview: true });
        return;
    }
    const records = teks.split('-----------------------------------\n');
    let pesan = records.shift(); // header
    for (const rec of records) {
        const potongan = rec + '-----------------------------------\n';
        if ((pesan + potongan).length > BATAS) {
            await ctx.reply(pesan, { disable_web_page_preview: true });
            pesan = '';
        }
        pesan += potongan;
    }
    if (pesan.trim()) await ctx.reply(pesan, { disable_web_page_preview: true });
}

module.exports = (bot, supabase) => {

    // ================================================================
    // Inti proses: REKAP (dengan pilihan format export)
    // periode: object hasil serializePeriode()
    // ================================================================
    async function prosesRekap(ctx, periode, format) {
        try {
            let query = supabase
                .from('laporan_visit')
                .select('id_pelanggan, nama_telkom_daerah, hasil_visit, keterangan, nama_petugas, waktu_visit, koordinat, foto_url')
                .order('waktu_visit', { ascending: false });

            if (periode.mode !== 'semua') {
                query = query.gte('waktu_visit', periode.startISO)
                               .lt('waktu_visit', periode.endISO);
            }

            const { data: rows, error } = await query;
            if (error) throw error;

            if (!rows || rows.length === 0) {
                return ctx.reply(`Tidak ada laporan visit pada periode: ${periode.label}`);
            }

            const rekapArea = agregasiPerArea(rows);

            if (format === 'png') {
                // PNG: tabel gambar rekap + detail teks (desain tidak diubah)
                try {
                    await kirimGambarRekap(ctx, rekapArea, periode.label);
                } catch (imgErr) {
                    console.error('Gagal buat gambar rekap:', imgErr.message);
                }
                await kirimDetail(ctx, detailTeks(rows, periode.label, 'REKAP LAPORAN VISIT'));
            } else {
                // Excel: file .xlsx (sheet Rekap + sheet Detail, desain tidak diubah)
                try {
                    await kirimExcelRekap(ctx, rows, rekapArea, periode.label);
                } catch (xlsErr) {
                    console.error('Gagal membuat/mengirim file Excel Rekap:', xlsErr);
                    ctx.reply('Terjadi kesalahan saat membuat file Excel.');
                }
            }
        } catch (error) {
            console.error('Error rekap laporan visit:', error);
            ctx.reply('Terjadi kesalahan saat menarik data dari database.');
        }
    }

    // ================================================================
    // Inti proses: RIWAYAT satu pelanggan (Excel + detail teks)
    // ================================================================
    async function prosesRiwayat(ctx, idPelanggan, periode) {
        await ctx.reply(`Mencari riwayat visit untuk ID Pelanggan: ${idPelanggan}...`);

        try {
            let query = supabase
                .from('laporan_visit')
                .select('*')
                .eq('id_pelanggan', idPelanggan)
                .order('waktu_visit', { ascending: false });

            if (periode.mode !== 'semua') {
                query = query.gte('waktu_visit', periode.startISO)
                               .lt('waktu_visit', periode.endISO);
            }

            const { data: rows, error } = await query;
            if (error) throw error;

            if (!rows || rows.length === 0) {
                return ctx.reply(`Tidak ditemukan riwayat visit untuk ID ${idPelanggan} pada periode: ${periode.label}`);
            }

            try {
                await kirimExcelRiwayat(ctx, rows, idPelanggan, periode.label);
            } catch (xlsErr) {
                console.error('Gagal membuat/mengirim file Excel Riwayat:', xlsErr);
            }

            await kirimDetail(ctx, detailTeks(rows, periode.label, `RIWAYAT VISIT - ID: ${idPelanggan}`));
        } catch (error) {
            console.error('Error riwayat visit:', error);
            ctx.reply('Terjadi kesalahan saat menarik data dari database.');
        }
    }

    // ================================================================
    // Minta pilihan format export (PNG / Excel) -- khusus Laporan Visit
    // ================================================================
    function mintaFormatExport(ctx, periode) {
        const p = serializePeriode(periode);
        ctx.session.step = 'rekap_pilih_format';
        ctx.session.data = { periode: p };
        return ctx.reply(
            `Periode dipilih: <b>${p.label}</b>\n\nPilih format export laporan:`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🖼️ PNG (Gambar)', 'rekap_fmt_png')],
                    [Markup.button.callback('📊 Excel (.xlsx)', 'rekap_fmt_xls')]
                ])
            }
        );
    }

    // ================================================================
    // 📊 Laporan Visit -- handler /laporan_visit & tombol 📊 Laporan Visit
    // ================================================================
    async function handlerLaporanVisit(ctx) {
        if (!(await isAdmin(supabase, ctx.from.id))) {
            return ctx.reply('Command ini khusus Admin / Master Admin.');
        }

        // Jalan pintas: /laporan_visit <tanggal/rentang>
        const text = ctx.message.text;
        const args = text.startsWith('/') ? text.trim().split(/\s+/).slice(1) : [];
        if (args.length > 0) {
            const periode = parseArgsPeriode(args);
            if (periode.mode === 'gagal') {
                return ctx.reply(
                    'Format tanggal tidak dikenali.\nContoh yang valid:\n' +
                    '- 05 11 2026\n- 05/11/2026\n- 05 November 2026\n- rentang: 01 11 2026 05 11 2026'
                );
            }
            if (periode.mode !== 'kosong') {
                return mintaFormatExport(ctx, periode);
            }
        }

        ctx.session.step = 'rekap_pilih_periode';
        ctx.session.data = {};
        return ctx.reply('Pilih periode laporan visit:', keyboardPeriode('rekap'));
    }
    bot.command('laporan_visit', handlerLaporanVisit);
    bot.hears('📊 Laporan Visit', handlerLaporanVisit);

    // ================================================================
    // 📝 Riwayat Visit -- handler /riwayat_visit & tombol 📝 Riwayat Visit
    // ================================================================
    async function handlerRiwayatVisit(ctx) {
        if (!(await isAdmin(supabase, ctx.from.id))) {
            return ctx.reply('Command ini khusus Admin / Master Admin.');
        }

        // Jalan pintas: /riwayat_visit <id> [tanggal/rentang]
        const text = ctx.message.text;
        const args = text.startsWith('/') ? text.trim().split(/\s+/).slice(1) : [];
        if (args.length > 0) {
            const idPelanggan = args[0];
            const periode = parseArgsPeriode(args.slice(1));
            if (periode.mode === 'gagal') {
                return ctx.reply('Format tanggal tidak dikenali. Contoh: 05 11 2026 atau 01 11 2026 05 11 2026');
            }
            ctx.session.data = { idPelanggan };
            if (periode.mode === 'kosong') {
                ctx.session.step = 'riwayat_pilih_periode';
                return ctx.reply(`Pilih periode riwayat visit untuk ID ${idPelanggan}:`, keyboardPeriode('riwayat'));
            }
            ctx.session.step = 'idle';
            return prosesRiwayat(ctx, idPelanggan, serializePeriode(periode));
        }

        // Alur bertahap: cukup ketik ID-nya saja
        ctx.session.step = 'riwayat_tunggu_id';
        ctx.session.data = {};
        return ctx.reply(
            'Silakan masukkan <b>ID Pelanggan</b> yang ingin dicek riwayat visitnya.\n\n' +
            'Ketik hanya ID-nya saja (contoh: <code>111201107052</code>) — tanpa perlu menulis command. ' +
            'Ketik /cancel untuk batal.',
            { parse_mode: 'HTML', ...Markup.removeKeyboard() }
        );
    }
    bot.command('riwayat_visit', handlerRiwayatVisit);
    bot.hears('📝 Riwayat Visit', handlerRiwayatVisit);

    // ================================================================
    // Tombol pilihan periode LAPORAN VISIT
    // ================================================================
    bot.action(/^rekap_(semua|hari_ini|kemarin|manual)$/, async (ctx) => {
        if (!(await isAdmin(supabase, ctx.from.id))) {
            return ctx.answerCbQuery('Command ini khusus Admin / Master Admin.', { show_alert: true });
        }
        await ctx.answerCbQuery();
        await ctx.editMessageReplyMarkup(undefined).catch(() => {});

        const pilihan = ctx.match[1];
        if (pilihan === 'manual') {
            ctx.session.step = 'rekap_tunggu_manual';
            ctx.session.data = {};
            return ctx.reply(
                'Ketik 1 tanggal (contoh: 05 11 2026) atau rentang tanggal (contoh: 01 11 2026 05 11 2026):',
                Markup.removeKeyboard()
            );
        }
        return mintaFormatExport(ctx, periodeDariPreset(pilihan));
    });

    // ================================================================
    // Tombol pilihan periode RIWAYAT VISIT
    // ================================================================
    bot.action(/^riwayat_(semua|hari_ini|kemarin|manual)$/, async (ctx) => {
        if (!(await isAdmin(supabase, ctx.from.id))) {
            return ctx.answerCbQuery('Command ini khusus Admin / Master Admin.', { show_alert: true });
        }
        await ctx.answerCbQuery();
        await ctx.editMessageReplyMarkup(undefined).catch(() => {});

        const idPelanggan = ctx.session?.data?.idPelanggan;
        if (!idPelanggan) {
            return ctx.reply('Sesi berakhir. Ulangi lewat tombol 📝 Riwayat Visit atau command /riwayat_visit.');
        }

        const pilihan = ctx.match[1];
        if (pilihan === 'manual') {
            ctx.session.step = 'riwayat_tunggu_manual';
            return ctx.reply(
                `Ketik tanggal untuk ID ${idPelanggan} (contoh: 05 11 2026) atau rentang (contoh: 01 11 2026 05 11 2026):`,
                Markup.removeKeyboard()
            );
        }
        ctx.session.step = 'idle';
        ctx.session.data = {};
        return prosesRiwayat(ctx, idPelanggan, serializePeriode(periodeDariPreset(pilihan)));
    });

    // ================================================================
    // Tombol pilihan format export LAPORAN VISIT
    // ================================================================
    bot.action(/^rekap_fmt_(png|xls)$/, async (ctx) => {
        if (ctx.session?.step !== 'rekap_pilih_format' || !ctx.session.data?.periode) {
            return ctx.answerCbQuery('Sesi pilih format sudah berakhir. Ulangi lewat tombol 📊 Laporan Visit.', { show_alert: true });
        }
        const format = ctx.match[1];
        const periode = ctx.session.data.periode;
        ctx.session.step = 'idle';
        ctx.session.data = {};

        await ctx.answerCbQuery();
        const labelFormat = format === 'png' ? 'PNG (Gambar)' : 'Excel (.xlsx)';
        await ctx.editMessageText(
            `Periode: <b>${periode.label}</b>\nFormat: <b>${labelFormat}</b>\n\nMemproses...`,
            { parse_mode: 'HTML' }
        ).catch(() => {});

        return prosesRekap(ctx, periode, format);
    });

    // ================================================================
    // Tangkap input teks bertahap:
    //   riwayat_tunggu_id  -> user mengetik ID pelanggan (boleh + tanggal)
    //   rekap_tunggu_manual  -> user mengetik tanggal/rentang untuk laporan visit
    //   riwayat_tunggu_manual -> user mengetik tanggal/rentang untuk riwayat
    // ================================================================
    bot.on('text', async (ctx, next) => {
        const step = ctx.session?.step;
        if (!['riwayat_tunggu_id', 'rekap_tunggu_manual', 'riwayat_tunggu_manual'].includes(step)) {
            return next();
        }

        const text = ctx.message.text;
        if (text.startsWith('/')) return next();
        if (MENU_LABELS.includes(text.trim())) return next(); // pindah fitur lewat tombol menu

        // --- Riwayat: tangkap ID pelanggan ---
        if (step === 'riwayat_tunggu_id') {
            const tokens = text.trim().split(/\s+/);
            const idPelanggan = tokens[0];
            const periode = parseArgsPeriode(tokens.slice(1));

            if (periode.mode === 'gagal') {
                return ctx.reply('Format tanggal tidak dikenali. Contoh: 05 11 2026 atau 01 11 2026 05 11 2026');
            }
            ctx.session.data = { idPelanggan };
            if (periode.mode === 'kosong') {
                ctx.session.step = 'riwayat_pilih_periode';
                return ctx.reply(`Pilih periode riwayat visit untuk ID ${idPelanggan}:`, keyboardPeriode('riwayat'));
            }
            ctx.session.step = 'idle';
            return prosesRiwayat(ctx, idPelanggan, serializePeriode(periode));
        }

        // --- Manual: tangkap tanggal/rentang ---
        const periode = parseArgsPeriode(text.trim().split(/\s+/));
        if (periode.mode !== 'satu' && periode.mode !== 'rentang') {
            return ctx.reply('Format tanggal tidak dikenali. Ketik 1 tanggal (contoh: 05 11 2026) atau rentang (contoh: 01 11 2026 05 11 2026):');
        }

        if (step === 'rekap_tunggu_manual') {
            return mintaFormatExport(ctx, periode); // session step/data di-set di dalam
        }

        // riwayat_tunggu_manual
        const idPelanggan = ctx.session.data?.idPelanggan;
        ctx.session.step = 'idle';
        ctx.session.data = {};
        if (!idPelanggan) {
            return ctx.reply('Sesi berakhir. Ulangi lewat tombol 📝 Riwayat Visit atau command /riwayat_visit.');
        }
        return prosesRiwayat(ctx, idPelanggan, serializePeriode(periode));
    });
};

// ============================================================================
// HELPER & FUNGSI GENERATE EXCEL (desain tidak diubah)
// ============================================================================

// Mengubah format tanggal DB menjadi format WIB (Asia/Jakarta)
function formatWaktuExcel(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
    const wib = new Date(utc + (3600000 * 7)); // UTC+7

    const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const pad = (n) => n.toString().padStart(2, '0');

    return `${pad(wib.getDate())} ${months[wib.getMonth()]} ${wib.getFullYear()} ${pad(wib.getHours())}:${pad(wib.getMinutes())}`;
}

// Membersihkan nama file dari karakter terlarang
function sanitizeFilename(name) {
    return name.replace(/[\\\/:*?"<>| ]/g, '_');
}

// Styling header tabel Excel (latar biru, teks putih, bold)
function applyHeaderStyle(cell) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF174F76' } };
    cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
}

// Sheet Detail/Riwayat (struktur kolom sama untuk rekap & riwayat)
function buildDetailSheet(ws, rows) {
    ws.columns = [
        { header: 'No', key: 'no', width: 5 },
        { header: 'ID Pelanggan', key: 'id_pelanggan', width: 18 },
        { header: 'Waktu Visit (WIB)', key: 'waktu', width: 22 },
        { header: 'Petugas', key: 'petugas', width: 20 },
        { header: 'Area', key: 'area', width: 18 },
        { header: 'Hasil Visit', key: 'hasil', width: 25 },
        { header: 'Keterangan', key: 'ket', width: 40 },
        { header: 'Foto', key: 'foto', width: 15 },
        { header: 'Koordinat', key: 'koordinat', width: 18 }
    ];
 
    ws.getRow(1).eachCell((cell) => applyHeaderStyle(cell));
    ws.autoFilter = { from: 'A1', to: 'I1' };

    ws.getRow(1).eachCell((cell) => applyHeaderStyle(cell));
    ws.autoFilter = { from: 'A1', to: 'H1' };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    rows.forEach((r, i) => {
        const row = ws.addRow({
            no: i + 1,
            id_pelanggan: r.id_pelanggan,
            waktu: formatWaktuExcel(r.waktu_visit),
            petugas: r.nama_petugas || '-',
            area: r.nama_telkom_daerah || '-',
            hasil: r.hasil_visit || '-',
            ket: r.keterangan || '-',
            foto: r.foto_url ? 'Lihat Foto' : '-',
            koordinat: '-'
        });
 
        const linkMaps = koordinatKeLink(r.koordinat);
        const koordCell = row.getCell(9);
        if (linkMaps) {
            koordCell.value = { text: 'Lihat Lokasi', hyperlink: linkMaps, tooltip: 'Buka di Google Maps' };
        }

        row.eachCell((cell, colNumber) => {
            cell.font = { name: 'Arial', size: 10 };
            cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
            cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: colNumber === 7 };
        });

        row.getCell(1).alignment = { vertical: 'top', horizontal: 'center' };
        row.getCell(2).alignment = { vertical: 'top', horizontal: 'center' };

        koordCell.font = linkMaps
            ? { name: 'Arial', size: 10, color: { argb: 'FF0563C1' }, underline: true }
            : { name: 'Arial', size: 10 };
        koordCell.alignment = { vertical: 'top', horizontal: 'center' };

        if (r.foto_url) {
            const fotoCell = row.getCell(8);
            fotoCell.value = { text: 'Lihat Foto', hyperlink: r.foto_url, tooltip: 'Buka gambar bukti visit' };
            fotoCell.font = { name: 'Arial', size: 10, color: { argb: 'FF0563C1' }, underline: true };
            fotoCell.alignment = { vertical: 'top', horizontal: 'center' };
        } else {
            row.getCell(8).alignment = { vertical: 'top', horizontal: 'center' };
        }
    });
}

// Generate & kirim Excel Rekap (2 Sheet: Rekap + Detail)
async function kirimExcelRekap(ctx, rows, rekapArea, labelPeriode) {
    if (!rows || rows.length === 0) return;

    const workbook = new ExcelJS.Workbook();

    const wsRekap = workbook.addWorksheet('Rekap', {
        pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 }
    });

    const totalCols = 2 + KATEGORI_HASIL.length;

    wsRekap.mergeCells(1, 1, 1, totalCols);
    const title = wsRekap.getCell(1, 1);
    title.value = 'REKAP LAPORAN VISIT';
    title.font = { name: 'Arial', size: 14, bold: true };
    title.alignment = { vertical: 'middle', horizontal: 'center' };

    wsRekap.mergeCells(2, 1, 2, totalCols);
    const subtitle = wsRekap.getCell(2, 1);
    subtitle.value = `Periode: ${labelPeriode}`;
    subtitle.font = { name: 'Arial', size: 11, color: { argb: 'FF333333' } };
    subtitle.alignment = { vertical: 'middle', horizontal: 'center' };

    const headers = ['AREA', 'TOTAL', ...KATEGORI_HASIL.map(k => k.label)];
    const headerRow = wsRekap.getRow(4);
    headerRow.values = headers;
    headerRow.eachCell((cell) => applyHeaderStyle(cell));

    wsRekap.getColumn(1).width = 22;
    wsRekap.getColumn(2).width = 10;
    for (let i = 3; i <= totalCols; i++) {
        wsRekap.getColumn(i).width = 16;
    }

    let rowIdx = 5;
    for (const [area, d] of Object.entries(rekapArea)) {
        const row = wsRekap.getRow(rowIdx);
        row.getCell(1).value = area;
        row.getCell(2).value = d.total;

        let colIdx = 3;
        for (const k of KATEGORI_HASIL) {
            row.getCell(colIdx).value = d[k.key] || 0;
            colIdx++;
        }

        row.eachCell((cell, colNumber) => {
            cell.font = { name: 'Arial', size: 10, bold: colNumber === 2 };
            cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
            cell.alignment = { vertical: 'middle', horizontal: colNumber === 1 ? 'left' : 'center' };
            if (colNumber >= 2) cell.numFmt = '0;-0;"-"';
        });
        rowIdx++;
    }

    wsRekap.views = [{ state: 'frozen', xSplit: 1, ySplit: 4 }];

    const wsDetail = workbook.addWorksheet('Detail');
    buildDetailSheet(wsDetail, rows);

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `Rekap_Visit_${sanitizeFilename(labelPeriode)}.xlsx`;

    await ctx.replyWithDocument({ source: buffer, filename }, {
        caption: `File Excel Rekap Visit (${labelPeriode})`
    });
}

// Generate & kirim Excel Riwayat (1 Sheet)
async function kirimExcelRiwayat(ctx, rows, idPelanggan, labelPeriode) {
    if (!rows || rows.length === 0) return;

    const workbook = new ExcelJS.Workbook();
    const wsRiwayat = workbook.addWorksheet('Riwayat');
    buildDetailSheet(wsRiwayat, rows);

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `Riwayat_Visit_${sanitizeFilename(idPelanggan)}_${sanitizeFilename(labelPeriode)}.xlsx`;

    await ctx.replyWithDocument({ source: buffer, filename }, {
        caption: `File Excel Riwayat Visit ID ${idPelanggan} (${labelPeriode})`
    });
}