/* IMPORTS */
const events = require('events');
const express = require('express');
const fetch = require('node-fetch');
const { createEventAdapter } = require('@slack/events-api');
const { createMessageAdapter } = require('@slack/interactive-messages');
const { WebClient } = require('@slack/web-api');

/* GLOBAL VARIABLES */
const app = express();
const port = process.env.PORT || 8080;
const slackEvents = createEventAdapter(process.env.SLACK_SIGNING_SECRET);
const slackInteractions = createMessageAdapter(process.env.SLACK_SIGNING_SECRET);
const slackClient = new WebClient(process.env.SLACK_TOKEN);
const covidAPI = 'http://corona-api.com/countries/COUNTRY_CODE';
const flagsAPI = 'https://www.countryflags.io/COUNTRY_CODE/flat/64.png';
const imagesURL = 'https://pandemico-images.s3.us-east-2.amazonaws.com/COLOR.png';
const countries = {};
const countryEvents = new events.EventEmitter();

/* RECEIVE SLACK EVENTS */
app.use('/events', slackEvents.requestListener());

/* REACT TO APP MENTIONS */
slackEvents.on('app_mention', async event => {
    console.log(`Received mention by ${event.user}: ${event.text}`);

    // Post country data to channel
    postCountryData(event.text.split(' ')[1], event.channel);

});

/* POST COUNTRY DATA TO CHANNEL */
const postCountryData = async (country, channel) => {

    // Initialize data object
    let data = {};

    // Fetch country data from COVID API
    try {
        const response = await fetch(covidAPI.replace('COUNTRY_CODE', country));
        if (response.ok) {
            const json = await response.json();

            // Calculate active cases
            const active = json.data.latest_data.confirmed - json.data.latest_data.deaths - json.data.latest_data.recovered;

            // Assemble data object
            data = {
                country: json.data.name,
                population: json.data.population,
                updated: new Date(json.data.updated_at),
                deaths: {
                    today: json.data.today.deaths,
                    total: json.data.latest_data.deaths,
                    rate: Math.round((json.data.latest_data.deaths / json.data.population) * 10000) / 100
                },
                confirmed: {
                    today: json.data.today.confirmed,
                    total: json.data.latest_data.confirmed,
                    rate: Math.round((json.data.latest_data.confirmed / json.data.population) * 10000) / 100
                },
                active: {
                    total: active,
                    rate: Math.round((active / json.data.population) * 10000) / 100
                }
            };

        } else {
            console.log(response);
        }
    } catch (error) {
        console.log(error);
    }

    // Post country data to Slack channel
    slackClient.chat.postMessage({
        channel: channel,
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `Latest data for ${data.country}:\n` +
                        "```Active:    " + ' '.repeat(7 - data.active.total.toString().length) +
                            data.active.total + " (" + data.active.rate + "%)\n" +
                        "Confirmed: " + ' '.repeat(7 - data.confirmed.total.toString().length) +
                            data.confirmed.total + " (" + data.confirmed.rate + "%) [Today: +" + data.confirmed.today + "]\n" +
                        "Deaths:    " + ' '.repeat(7 - data.deaths.total.toString().length) +
                            data.deaths.total + " (" + data.deaths.rate + "%) [Today: +" + data.deaths.today + "]```"
                },
                accessory: {
                    type: 'image',
                    image_url: flagsAPI.replace('COUNTRY_CODE', country),
                    alt_text: `flag for ${data.country}`
                }
            },
            {
                type: 'context',
                elements: [
                    {
                        type: 'mrkdwn',
                        text: `Source: ${covidAPI.replace('COUNTRY_CODE', country)}\n` +
                              `Updated: ${data.updated}`
                    }
                ]
            },
            {
                type: 'divider'
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `Latest advice for ${data.country}:\n\n${isClosed(country) ?
                        "      _*Please work from home and refrain from any travel.*_" :
                        "      _Please remain cautious and limit office visits and travel._"}`
                },
                accessory: {
                    type: 'image',
                    image_url: imagesURL.replace('COLOR', isClosed(country) ? 'red' : 'amber'),
                    alt_text: `status for ${data.country}`
                }
            },
            {
                type: 'context',
                elements: [
                    {
                        type: 'mrkdwn',
                        text: `Updated: ${countries[country] && countries[country].closed_ts ? countries[country].closed_ts : new Date()}`
                    }
                ]
            },
            {
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        text: {
                            type: 'plain_text',
                            text: isSubscribed(country, channel) ? 'Unsubscribe' : 'Subscribe'
                        },
                        action_id: isSubscribed(country, channel) ? 'pandemico_unsubscribe' : 'pandemico_subscribe',
                        value: country
                    },
                    {
                        type: 'button',
                        text: {
                            type: 'plain_text',
                            text: isClosed(country) ? 'Open Country' : 'Close Country'
                        },
                        style: isClosed(country) ? 'primary' : 'danger',
                        action_id: isClosed(country) ? 'pandemico_open' : 'pandemico_close',
                        value: country
                    }
                ]
            }
        ]
    });
};

/* RECEIVE SLACK INTERACTIONS */
app.use('/interactions', slackInteractions.requestListener());

/* REACT TO APP BUTTON INTERACTIONS */
slackInteractions.action({ type: 'button' }, (payload, respond) => {
    console.log(`Received button interaction: ${payload.type}`);

    // Respond the block actions
    if (payload.type === 'block_actions') {
        for (const action of payload.actions) {

            // Respond the subscribe action
            if (action.action_id === 'pandemico_subscribe') {

                // Subscribe user
                setSubscribed(action.value, payload.user.id, true);

                respond({
                    text: `User subscribed: ${payload.user.username} to ${action.value}`,
                    response_type: 'ephemeral',
                    replace_original: false
                });

            // Respond the unsubscribe action
            } else if (action.action_id === 'pandemico_unsubscribe') {

                // Unsubscribe user
                setSubscribed(action.value, payload.user.id, false);

                respond({
                    text: `User unsubscribed: ${payload.user.username} from ${action.value}`,
                    response_type: 'ephemeral',
                    replace_original: false
                });

            // Respond the close action
            } else if (action.action_id === 'pandemico_close') {

                // Close country
                setClosed(action.value, true);

                respond({
                    text: `Country closed: ${action.value}`,
                    response_type: 'ephemeral',
                    replace_original: false
                });

            // Respond the open action
            } else if (action.action_id === 'pandemico_open') {

                // Open country
                setClosed(action.value, false);

                respond({
                    text: `Country opened: ${action.value}`,
                    response_type: 'ephemeral',
                    replace_original: false
                });

            // Respond the unknown action
            } else {

                respond({
                    text: `Sorry, I don't recognize this action: ${action}`,
                    response_type: 'ephemeral',
                    replace_original: false
                });

            }

        }

    // Respond the unknown interaction types
    } else {

        respond({
            text: `Sorry, I don't recognize this type of interaction: ${payload.type}`,
            response_type: 'ephemeral',
            replace_original: false
        });

    }

});

/* SET COUNTRY-USER SUBSCRIBED */
const setSubscribed = (country, user, subscribe) => {

    // Check if change
    if (isSubscribed(country, user) !== subscribe) {

        // Subscribe
        if (subscribe) {
            if (countries[country]) {
                if (countries[country].subscribers) {
                    countries[country].subscribers.push(user);
                } else {
                    countries[country].subscribers = [user];
                }
            } else {
                countries[country] = {
                    subscribers: [user]
                };
            }

            // Post country data to user
            postCountryData(country, user);

        // Unsubscribe
        } else if (countries[country] && countries[country].subscribers) {
            countries[country].subscribers.splice(countries[country].subscribers.indexOf(user), 1);
        }

    }

};

/* CHECK WHETHER USER IS SUBSCRIBED */
const isSubscribed = (country, user) => countries[country] && countries[country].subscribers ? countries[country].subscribers.includes(user) : false;

/* SET COUNTRY CLOSED */
const setClosed = (country, close) => {

    // Check if change
    if (isClosed(country) !== close) {

        // Change country closed status
        if (countries[country]) {
            countries[country].closed = close;
            countries[country].closed_ts = new Date();
        } else {
            countries[country] = {
                closed: close,
                closed_ts: new Date()
            };
        }

        // Notify change
        countryEvents.emit('change', country);

    }

};

/* CHECK WHETHER COUNTRY IS CLOSED */
const isClosed = country => countries[country] ? countries[country].closed : false;

/* LISTEN TO COUNTRY CHANGES */
countryEvents.on('change', country => {

    // Notify subscribers of change
    if (countries[country] && countries[country].subscribers) {
        for (const subscriber of countries[country].subscribers) {
            postCountryData(country, subscriber);
        }
    }

});

/* START SERVER */
app.listen(port, () => {
    console.log(`Listening on port ${port}`);
});