/* eslint-disable no-underscore-dangle */
/* eslint-disable import/no-named-as-default */
/* eslint-disable import/no-named-as-default-member */

import _ from 'lodash';
import fs from 'fs';
import moment from 'moment-timezone';
import Mixpanel from 'mixpanel';
import colors from 'colors';
import Dates from './Dates.js';
import mpTokens from '../tokens/mixpanel-tokens.js';
import connect from './connect.js';
import pkg from './dataset.js';

// import { createRequire } from "module";
// const require = createRequire(import.meta.url);

moment.tz.setDefault('Europe/Prague');

const {
  target,
  databasePage,
  pageLimit,
  workDays,
  deals,
  contactsFieldsId,
  funnels,
  finished,
  startingTimecut,
  stoppingTimecut,
  eventsTimeGap,
} = pkg;

const stageChangeQuery = {
  leads_statuses: [
    { pipeline_id: deals.id, status_id: deals.full },
    { pipeline_id: deals.id, status_id: deals.demo },
  ],
};

const statuses = [
  { pipeline_id: deals.id, status_id: finished },
  { pipeline_id: deals.id, status_id: deals.full },
  { pipeline_id: deals.id, status_id: deals.demo },
  { pipeline_id: deals.id, status_id: deals.full_prolong },
  { pipeline_id: deals.id, status_id: deals.demo_prolong },
  { pipeline_id: deals.id, status_id: deals.hold },
];

console.log(colors.bgWhite.grey(`\nUpdater started in "${target}" mode\n`));
const mixpanelToken = mpTokens[`${target}`].token;
const mixpanelSecret = mpTokens[`${target}`].secret;

const mixpanelImporter = Mixpanel.init(
  mixpanelToken,
  {
    secret: mixpanelSecret,
    debug: false,
    verbose: false,
  },
);

const crm = connect();

const addLeadsStats = async (pageNum) => {
  console.log(colors.bgMagenta.white(`addLeadsStats FUNCTION for page #${pageNum} is run \n`));
  const statsWithLeads = [];
  await crm.request
    .get('/api/v4/leads', {
      page: pageNum,
      limit: pageLimit,
      with: 'contacts',
      filter: {
        statuses,
      },
    })
    .then(({ data }) => {
      if (!data) return;
      if (data.status === 401) {
        console.log(colors.bgMagenta.white(`${data.title}: ${data.detail}`));
        process.exit(0);
      }
      const { _embedded } = data;
      const { leads } = _embedded;

      leads.forEach((lead) => {
        const { _embedded: embedded } = lead;
        const { contacts: contact } = embedded;
        let customerId = 0;
        if (!contact.length) return;
        if (contact.length === 1) customerId = [contact[0].id];
        if (contact.length > 1) customerId = contact.map((item) => item.id);

        statsWithLeads.push(
          {
            lead: {
              lead_id: lead.id,
              created_at: lead.created_at * 1000,
              status_id: lead.status_id,
              pipeline_id: lead.pipeline_id,
            },
            customer: {
              customer_id: customerId,
            },
          },
        );
      });
    })
    .catch((error) => console.log(colors.bgMagenta.white('There is an Error: ', error)));

  return statsWithLeads.length
    ? [...statsWithLeads, ...(await addLeadsStats(pageNum + 1))]
    : [];
};

const addCustomersStats = async (statsWithLeads) => {
  console.log(colors.bgMagenta.white('addCustomersStats FUNCTION is run \n'));
  const statsWithCustomers = [...statsWithLeads];
  const customers_list = {};

  await Promise.all(

    statsWithCustomers.map(async (item)=>{
      const { customer } = item;
      const { customer_id: customerId } = customer;
      const [id] = customerId;

      if (customers_list[id] === undefined) {

        await crm.request
          .get(`/api/v4/contacts/${id}`, {
            with: 'contacts',
          })
          .then(({ data })=>{
            const [firstName, lastName] = _.split(data.name, ' ');
            customer.first_name = firstName;
            customer.last_name = lastName || 'unknown';

            const { custom_fields_values: fields } = data;
            if (!fields) return;

            fields.forEach((field) => {
              const { field_id: fieldId } = field;
              const [value] = field.values;
              switch (fieldId) {
                case contactsFieldsId.email:
                  customer.email = value.value;
                  break;
                case contactsFieldsId.phone:
                  customer.phone = value.value;
                  break;
                case contactsFieldsId.address:
                  customer.address = value.value;
                  break;
                default:
                  break;
              }
            });
          })
          .catch((error) => {
            console.log(colors.bgMagenta.white('ERROR: ', error))
          });

        customers_list[id] = customer;
      }
      else {
        customer = customers_list[id];
      }
    })// map
  )
  .then(()=>{
    // nothing
  });

  return statsWithCustomers;
};

const addEventsStats = async (statsWithCustomers) => {
  console.log(colors.bgMagenta.white('addEventsStats FUNCTION is run \n'));
  const statsWithEvents = [...statsWithCustomers];

  await Promise.all(
    statsWithEvents.map(async (statItem) => {
      const { lead } = statItem;
      const { lead_id: id } = lead;
      const eventsBeginning = [];
      const eventsEnding = [];

      await crm.request
        .get('/api/v4/events', {
          filter: {
            entity: 'lead',
            entity_id: id,
            type: 'lead_status_changed',
            value_after: stageChangeQuery,
          },
        })
        .then(async ({ data }) => {
          if (!data || !data._embedded) return;
          const { _embedded } = data;
          const { events } = _embedded;
          events.forEach((event) => eventsBeginning.push(moment(event.created_at * 1000).tz('Europe/Prague')));
          lead.events_beginning = [...eventsBeginning];

          await crm.request
            .get('/api/v4/events', {
              filter: {
                entity: 'lead',
                entity_id: id,
                type: 'lead_status_changed',
                value_before: stageChangeQuery,
              },
            })
            .then(({ data: $data }) => {
              if ($data) {
                const { _embedded: $embedded } = $data;
                const { events: $events } = $embedded;
                $events.forEach((event) => eventsEnding.push(moment(event.created_at * 1000).tz('Europe/Prague')));
              }
              lead.events_ending = [...eventsEnding];
            })
            .catch((error) => console.log(error));
        })
        .catch((error) => console.log(error));

    })// map
  )
  .then(()=>{
    // console.log('something');
  });

  return _.filter(statsWithEvents, 'lead.events_beginning')
};

const buildProdPeriods = (statsWithEvents) => {
  console.log(colors.bgMagenta.white('buildProdPeriods FUNCTION is run \n'));
  const statsWithBuildedProdPeriods = [...statsWithEvents];

  statsWithBuildedProdPeriods.forEach((item) => {
    const { lead } = item;
    const { events_beginning: events_beginning, events_ending: events_ending } = lead;
    const prodPeriods = [];
    if (_.isEmpty(events_beginning)) return;

    const begin = _.sortBy(events_beginning, (v) => v);

    if (_.isEmpty(events_ending)) {
      prodPeriods.push([_.head(begin)]);
    } else {
      const end = _.sortBy(events_ending, (v) => v);
      const timestampEnd = _.map(begin, (date) => Dates.dateToTimestamp(date));

      begin.forEach((beginDate) => {
        const sortedPlace = _.sortedIndexOf(timestampEnd, Dates.dateToTimestamp(beginDate));
        const endingDate = _.get(end, `${sortedPlace}`);
        prodPeriods.push(_.compact([beginDate, endingDate]));
      });
    }
    lead.prodPeriods = [...prodPeriods];
  });
  return statsWithBuildedProdPeriods;
};

const buildWorkDates = (chunked, todayEndingTimestamp) => {
  if (_.isEmpty(chunked)) return [];

  const [begin] = chunked;
  let end = '';
  if (chunked[1]) {
    [, end] = chunked;
  } else {
    end = todayEndingTimestamp;
  }

  if (Dates.dateToString(begin) === Dates.dateToString(end)
    && Dates.dateToTime(begin) > startingTimecut) {
    return [];
  }

  const iter = (newBegin) => {
    const workDates = [];
    if (Dates.dateToString(newBegin) >= Dates.dateToString(end)) {
      if (Dates.dateToTime(end) > stoppingTimecut) {
        // next directive with 'eventsTimeGap' does exclude
        // the pair of the two nearest events if
        // there is less then 5 minutes gap between them (no fake events)
        if (moment(end) - moment(begin) > eventsTimeGap) { // link to 'begin' is correct!
          if (workDays.includes(Dates.dateToWeekday(newBegin))) {
            workDates.push(Dates.dateToString(newBegin));
          } else {
            return workDates;
          }
        }
      } else {
        return workDates;
      }
      // this directive fixes the problem of doubled final working dates
      return workDates;
    }
    if (Dates.dateToString(newBegin) === Dates.dateToString(begin)) {
      if (Dates.dateToTime(newBegin) < startingTimecut) {
        if (workDays.includes(Dates.dateToWeekday(newBegin))) {
          workDates.push(Dates.dateToString(newBegin));
        }
      }
    } else if (Dates.dateToString(newBegin) > Dates.dateToString(begin)) {
      if (workDays.includes(Dates.dateToWeekday(newBegin))) {
        workDates.push(Dates.dateToString(newBegin));
      }
    }
    const nextNewBegin = Dates.datePlusOneDay(newBegin);
    return [...workDates, ...iter(nextNewBegin)];
  };

  const result = iter(begin);
  return result;
};

const addWorkDatesStats = (statsWithBuildedProdPeriods) => {
  console.log(colors.bgMagenta.white('addWorkDatesStats FUNCTION is run \n'));
  const statsWithWorkDates = [...statsWithBuildedProdPeriods];
  const todayEndingTimestamp = moment({ hour: 23, minute: 59, seconds: 59 }).format('X') * 1000;

  statsWithWorkDates.forEach((item) => {
    const workDates = [];
    const { lead } = item;
    const { prodPeriods } = lead;

    prodPeriods.forEach((chunked) => {
      const result = buildWorkDates(chunked, todayEndingTimestamp);
      workDates.push(...result);
    });
    lead.work_dates = workDates;
  });
  return statsWithWorkDates;
};

const customersUniquify = (collection) => {
  const unifiedColl = [];

  collection.forEach(({ lead, customer }) => {
    const lastProductionDate = _.last(lead.work_dates) || null;
    const [id] = customer.customer_id;

    if (_.some(unifiedColl, ['id', id])) {
      const foundCustomer = _.find(unifiedColl, ['id', id]);
      if (foundCustomer.last_date < lastProductionDate) {
        foundCustomer.last_date = lastProductionDate;
      }
    } else {
      unifiedColl.push(
        {
          id,
          first_name: customer.first_name,
          last_name: customer.last_name,
          email: customer.email,
          phone: customer.phone,
          last_date: lastProductionDate,
        },
      );
    }
  });
  return unifiedColl;
};

const importUsers = (collection) => {
  const unifiedColl = customersUniquify(collection);

  unifiedColl.forEach((customer) => {
    const fullName = customer.last_name !== 'unknown'
      ? `${customer.first_name} ${customer.last_name}`
      : `${customer.first_name}`;

    mixpanelImporter.people.set(customer.id, {
      _id: customer.id,
      $first_name: customer.first_name,
      $last_name: customer.last_name,
      _full_name: fullName,
      $email: customer.email,
      $phone: customer.phone,
      _last_date: customer.last_date,
    });
  });
  console.log(colors.bgBrightCyan.white('Stats of Users for Import: ', unifiedColl.length, '\n'));
};

const splitLeadsToEvents = (collection, dateForUpdate) => {
  console.log('splitLeadsToEvents for date: ', dateForUpdate);
  console.log('Collection size: ', collection.length, '\n');
  const splitedEvents = [];

  collection.forEach(({ lead, customer }) => {
    const { work_dates: dates } = lead;

    dates.forEach((date) => {
      if (date === dateForUpdate) {
        const pipeline = _.findKey(funnels, (item) => item.id === lead.pipeline_id);
        const event = {
          event: 'Vyroba',
          properties: {
            $insert_id: `${lead.lead_id}-${date}`,
            distinct_id: customer.customer_id[0],
            // time: date, // human readable value specially for dump
            time: Dates.dateToTimestamp(`${date} 00:01`),
            lead_id: lead.lead_id,
            pipeline,
          },
        };
        splitedEvents.push(event);
      }
    });
  });
  return splitedEvents;
};

const importEvents = (collection) => {
  const splitedEvents = splitLeadsToEvents(collection, moment().subtract(1, 'days').format('YYYY-MM-DD'));
  console.log(colors.bgBrightCyan.white('Stats of Splited Events for Import: ', splitedEvents.length, '\n'));
  mixpanelImporter.import_batch(splitedEvents);
};

const writeDump = (fileNum, fileName, data) => {
  fs.writeFile(`./temp/dump/${fileNum}_${fileName}.json`, JSON.stringify(data), (error) => {
    if (error) throw new Error(error);
    console.log(colors.bgGreen.white(`${fileName} successfully wrote.\n`));
  });
}

export default async () => {
  console.time("Update completed in ");

  await crm.connection.refreshToken();

  const statsWithLeads = await addLeadsStats(databasePage);
  console.log(colors.bgMagenta.white('Stats With Leads | length: ', statsWithLeads.length, '\n'));
  if (statsWithLeads.length === 0) return;
  writeDump(1, 'statsWithLeads', statsWithLeads);
  // const statsWithLeads = require('../temp/dump/1_statsWithLeads.json');


  const statsWithCustomers = await addCustomersStats(statsWithLeads);
  console.log(colors.bgMagenta.white('Stats With Customers | length: ', statsWithCustomers.length, '\n'));
  writeDump(2, 'statsWithCustomers', statsWithCustomers);
  // const statsWithCustomers = require('../temp/dump/2_statsWithCustomers.json');


  const statsWithEvents = await addEventsStats(statsWithCustomers);
  console.log(colors.bgMagenta.white('Stats With Events | length: ', statsWithEvents.length, '\n'));
  writeDump(3, 'statsWithEvents', statsWithEvents);
  // const statsWithEvents = require('../temp/dump/3_statsWithEvents.json');


  const statsWithBuildedProdPeriods = buildProdPeriods(statsWithEvents);
  console.log(colors.bgMagenta.white('Stats With Builded ProdPeriods | length: ', statsWithBuildedProdPeriods.length, '\n'));
  writeDump(4, 'statsWithBuildedProdPeriods', statsWithBuildedProdPeriods);
  // const statsWithBuildedProdPeriods = require('../temp/dump/4_statsWithBuildedProdPeriods.json');


  const statsWithWorkDates = addWorkDatesStats(statsWithBuildedProdPeriods);
  console.log(colors.bgMagenta.white('Stats With WorkDates | length: ', statsWithWorkDates.length, '\n'));
  writeDump(5, 'statsWithWorkDates', statsWithWorkDates);
  // const statsWithWorkDates = require('../temp/dump/5_statsWithWorkDates.json');


  importUsers(statsWithWorkDates);
  importEvents(statsWithWorkDates);

  console.timeEnd("Update completed in ");
};
