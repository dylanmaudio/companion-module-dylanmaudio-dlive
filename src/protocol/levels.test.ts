import { describe, expect, it } from 'vitest'
import {
	LV_TO_DB,
	dbToLv,
	lvToDb,
	stepDb,
	formatDb,
	parseDb,
	UNITY_LV,
	LV_MEASURED,
	eqFreqFromValue,
	eqFreqToValue,
	hpfFreqFromValue,
	preampGainToValue,
	preampValueToGain,
} from './levels.js'

describe('fader level table', () => {
	it('unity is 0x6B and −∞ is 0', () => {
		expect(lvToDb(UNITY_LV)).toBe(0)
		expect(lvToDb(0)).toBeNull()
		expect(dbToLv(0)).toBe(UNITY_LV)
		expect(dbToLv(null)).toBe(0)
	})
	it('is monotonic and fully populated', () => {
		for (let lv = 2; lv < 128; lv++) {
			expect(LV_TO_DB[lv]).not.toBeNull()
			expect(LV_TO_DB[lv] as number).toBeGreaterThan(LV_TO_DB[lv - 1] as number)
		}
	})
	it('keeps measured anchors exact', () => {
		expect(lvToDb(8)).toBe(-49.9)
		expect(lvToDb(67)).toBe(-20.2)
		expect(lvToDb(127)).toBe(9.9)
		expect(LV_MEASURED.filter(Boolean).length).toBe(53)
	})
	it('interpolates between anchors', () => {
		expect(lvToDb(118)).toBe(5.4)
		expect(lvToDb(13)).toBe(-47.4)
	})
	it('round-trips dB targets through nearest LV', () => {
		expect(dbToLv(-6)).toBe(95)
		expect(dbToLv(-20)).toBe(67)
		expect(dbToLv(10)).toBe(127)
		expect(dbToLv(-80)).toBe(1)
	})
	it('steps by dB along the table', () => {
		expect(stepDb(UNITY_LV, -3)).toBe(101)
		expect(stepDb(UNITY_LV, 1)).toBe(109)
		expect(stepDb(0, -1)).toBe(0)
		expect(stepDb(3, -10)).toBe(0)
	})
	it('formats and parses', () => {
		expect(formatDb(0)).toBe('0.0 dB')
		expect(formatDb(3.4)).toBe('+3.4 dB')
		expect(formatDb(null)).toBe('-inf dB')
		expect(parseDb('-6')).toBe(-6)
		expect(parseDb('+3.5 dB')).toBe(3.5)
		expect(parseDb('-inf')).toBeNull()
		expect(parseDb('abc')).toBeUndefined()
	})
})

describe('other value maps', () => {
	it('EQ frequency is 20 Hz..20 kHz log', () => {
		expect(eqFreqFromValue(0)).toBe(20)
		expect(eqFreqFromValue(127)).toBe(20000)
		expect(eqFreqToValue(1000)).toBe(72)
	})
	it('HPF frequency is 20 Hz..2 kHz log', () => {
		expect(hpfFreqFromValue(0)).toBe(20)
		expect(hpfFreqFromValue(127)).toBe(2000)
	})
	it('preamp gain maps linearly in the chosen range', () => {
		expect(preampGainToValue(5, 'spec')).toBe(0)
		expect(preampGainToValue(60, 'spec')).toBe(127)
		expect(preampValueToGain(64, 'spec')).toBe(32.5)
		expect(preampGainToValue(-10, 'legacy')).toBe(0)
	})
})
